import { KernError, type Tx } from '@kernhq/kernel'
import { and, eq, isNull } from 'drizzle-orm'
import type { AssetStatus } from '../../contract/models.js'
import { assets, repairs } from '../schema.js'

/**
 * What an asset's status is, decided in one place from the facts that decide it.
 *
 * `assets.status` is stored rather than computed, because every list filter asks for it — but it is
 * **derived**, and the moment two services each wrote their own version of the derivation they
 * disagreed. That is not hypothetical: `CustodyService.stamp` wrote `userId ? 'assigned' :
 * 'in_stock'` unconditionally, so handing over a laptop that was sitting at the repairer would have
 * announced it as back in the office. Both services now read this function, so there is one answer
 * and a test can hold it.
 *
 * ## The rule, written down because it is a decision rather than an inevitability
 *
 * **Custody and repair are independent facts, and repair wins the status column.** An item can be
 * out for repair *while still assigned to somebody*: Dan's laptop goes to the workshop, Dan is still
 * answerable for it, the custody period stays open and `custodian_user_id` stays set. Only `status`
 * moves, because `status` is the column that answers *where is it*, and "with a repairer" is the
 * answer somebody looking for it needs. Custody is answered by `custodian_user_id`, which is a
 * different column and is not touched.
 *
 * Two consequences follow, and both are deliberate:
 *
 * - **No custody procedure refuses an item that is away for repair.** Refusing `assign` would mean
 *   refusing `return` too, and somebody leaving the company while their laptop is at the workshop
 *   must still be able to hand it back. All three verbs recompute the status through this function
 *   instead, so a return during a repair leaves the item `under_repair` with nobody holding it,
 *   which is exactly true.
 * - **Completing a repair does not blindly go to `in_stock`.** It goes back to whatever custody
 *   says — `assigned` when somebody still holds it — because the repair never released them.
 *
 * `reserved`, `lost` and `retired` are not derivable from anything this module records: they are set
 * by hand by the features that will own them, and nothing writes them today. When something does,
 * it either belongs in this function with a fact of its own or it does not belong in this column.
 *
 * ## The third fact, which is not about the item at all
 *
 * **`under_repair` belongs to the `repairs` capability, so a workspace that has switched repairs
 * off never has an asset in it.** That is not cosmetic tidying, it is the thing that stopped an
 * asset being stranded: with the capability off, `repairs.complete` answers 404, so the row that
 * decides `under_repair` can never be closed — and the item sat in a status nothing could move it
 * out of, behind an archive that refused it for the same reason. Reading the switch here is what
 * makes the capability reversible in both directions rather than one: switch repairs off and the
 * next thing that touches the asset derives its status from custody alone; switch it back on and
 * the open repair asserts itself again, because nothing was destroyed to get out of it.
 *
 * The switch is read *before* the transaction opens, like every other settings lookup in this
 * module, and handed down as `repairsOn` — a `kernel.settings` call is a broker round trip and
 * awaiting one while holding a pooled connection is the failure `AssetService.codeFormat`
 * documents. `jobs.ts` reconciles the rows nobody happens to touch.
 */
export interface StatusFacts {
  /** `assets.custodian_user_id` — who is answerable for it, which a repair does not change. */
  custodianUserId: string | null
  /** An **open repair this workspace is recording** — see `awayForRepair` below. */
  awayForRepair: boolean
}

export function deriveStatus(facts: StatusFacts): AssetStatus {
  if (facts.awayForRepair) return 'under_repair'
  return facts.custodianUserId ? 'assigned' : 'in_stock'
}

/**
 * Is this item away for a repair the workspace still records?
 *
 * Two facts, and the capability is checked first so the query is skipped entirely for a workspace
 * that does not record repairs. Every caller that decides a status goes through this rather than
 * through `openRepairId` directly, so there is one answer to "is it away" and a test can hold it.
 */
export async function awayForRepair(
  tx: Tx,
  workspaceId: string,
  assetId: string,
  repairsOn: boolean,
): Promise<boolean> {
  if (!repairsOn) return false
  return (await openRepairId(tx, workspaceId, assetId)) !== undefined
}

/**
 * The open repair for one asset, if there is one — the query behind `awayForRepair`.
 *
 * At most one exists by construction: `inventory_repairs_one_open_uq` is a unique index on
 * `(asset_id) where returned_on is null`. It lives here rather than in `RepairService` so that
 * `CustodyService` can read the fact without depending on the whole repair service, and so that
 * every caller decides a status the same way — read both facts, then call `deriveStatus`, never
 * assume one of them.
 */
/**
 * The asset row, locked for the rest of the transaction — the serialisation point for `status`.
 *
 * **`status` is derived from two facts written by two different services, so the derivation needs a
 * lock even though neither fact does.** `CustodyService` decides it from custody *and* the open
 * repair; `RepairService` decides it from the repair *and* the custodian. Each used to read the
 * other's fact without a lock, so a handover and a repair completing at the same instant
 * interleaved into a status that matched neither: the second writer had read the first one's fact
 * before it was written, derived from a snapshot that no longer existed, and overwrote the answer.
 * That is a lost update in the plain sense — two transactions, one column, one of them silently
 * discarded.
 *
 * Both paths now take this lock **before** reading either fact, so the second one waits, re-reads
 * what the first committed, and derives from the state that actually exists. `for('update')`
 * re-evaluates the row at the latest committed version once the lock is granted, which is exactly
 * what makes the re-read honest rather than a repeat of the stale snapshot.
 *
 * **It is not the arbiter of "already held" or "already away".** Those stay with the exclusion
 * constraint and the partial unique index, for the reason both services' docblocks give: locking
 * the asset first would serialise two handovers into two *successful* handovers. This lock is taken
 * after the row that decides the race has been written, so it orders the bookkeeping without
 * deciding the contest.
 */
export async function lockAsset(
  tx: Tx,
  workspaceId: string,
  assetId: string,
): Promise<typeof assets.$inferSelect> {
  const [row] = await tx
    .select()
    .from(assets)
    .where(and(eq(assets.workspaceId, workspaceId), eq(assets.id, assetId)))
    .for('update')
  if (!row) throw KernError.notFound('Asset')
  return row
}

export async function openRepairId(
  tx: Tx,
  workspaceId: string,
  assetId: string,
): Promise<string | undefined> {
  const [row] = await tx
    .select({ id: repairs.id })
    .from(repairs)
    .where(
      and(eq(repairs.workspaceId, workspaceId), eq(repairs.assetId, assetId), isNull(repairs.returnedOn)),
    )
    .limit(1)
  return row?.id
}
