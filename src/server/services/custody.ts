import { KernError, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { CustodyPeriod as CustodyPeriodModel } from '../../contract/models.js'
import { assets, custodyPeriods } from '../schema.js'
import { violated } from './db-errors.js'
import type { HistoryInput, NotifyService } from './notify.js'
import { awayForRepair, deriveStatus, dispositionOf, lockAsset } from './status.js'

type AssetRow = typeof assets.$inferSelect
type PeriodRow = typeof custodyPeriods.$inferSelect

/** The GiST exclusion constraint `0001_rls.sql` added. Two open periods for one asset are it. */
const NO_OVERLAP = 'inventory_custody_no_overlap'

/**
 * One millisecond: the finest a JS `Date` resolves, and therefore the shortest custody period this
 * module is able to write. See `instant` — it is what keeps two changes in the same millisecond
 * from recording a period nobody held the item for.
 */
const TICK_MS = 1

/** The wire shape: drizzle gives Date objects for timestamps, the contract promises ISO strings. */
export function toCustodyPeriod(row: PeriodRow): CustodyPeriodModel {
  return {
    id: row.id,
    workspaceId: row.workspaceId as CustodyPeriodModel['workspaceId'],
    assetId: row.assetId,
    userId: row.userId,
    note: row.note,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * What one custody change wrote, and what may only leave the module once it has committed.
 *
 * `previousUserId` and `userId` are what `inventory.custody.changed` carries, and between them they
 * say which of the three verbs happened without a fourth field claiming to: out from stock has no
 * previous, back to stock has no next, a hand-on has both.
 */
export interface CustodyWritten {
  asset: AssetRow
  /** The period this call opened. Null on a return: something closed, nothing opened. */
  period: PeriodRow | null
  userId: string | null
  previousUserId: string | null
  activity: HistoryInput
  /** Who to tell, which is the recipient and never the person doing the handing. */
  notifyUserId: string | null
}

/**
 * Who is holding what, over time.
 *
 * Effective-dated the way HR keeps employments: **nothing is ever updated in place**. A change
 * closes the open row and inserts a new one, so the answer to "who had this laptop in March" is a
 * row that still exists rather than a value that was overwritten.
 *
 * Three things happen in one transaction on every change, and the whole point of the class is that
 * they cannot come apart: the period rows move, `assets.custodian_user_id`/`custody_since`/`status`
 * are brought into step with them, and an `asset_history` entry records it. The denormalised
 * columns on `assets` are what the list filters and the widget read; they are correct because they
 * are written here, in the same transaction, and never by a job afterwards.
 *
 * **A repair never refuses a handover.** An item at the repairer is still somebody's
 * responsibility, so none of the three verbs looks at repair state to decide whether it may run —
 * refusing `assign` would mean refusing `return` as well, and somebody leaving the company while
 * their laptop is in the workshop has to be able to hand it back. What repair state *does* affect
 * is the status these three write, which is `deriveStatus`'s job and is argued in `status.ts`.
 *
 * **The database is the arbiter of who won, not this file.** There is deliberately no `select … for
 * update` before the period is inserted. `inventory_custody_no_overlap` — a GiST exclusion
 * constraint on `(asset_id =, tstzrange(effective_from, effective_to, '[)') &&)` — is what makes two
 * open periods impossible, so two people pressing *Hand over* on the same laptop in the same instant
 * both read "nobody has it", both insert, and Postgres refuses exactly one of them. Locking the
 * asset first would serialise them into two successful handovers, which is a worse answer wearing
 * the clothes of a safer one. What this file owes the loser is a sentence they can act on rather
 * than drizzle's "Failed query: insert into mod_inventory.custody_periods …", and that is `refuse()`
 * below.
 *
 * **The asset row *is* locked afterwards, and that is a different job.** `stamp` takes it before it
 * reads the repair state, because `status` is derived from two facts two services write and the
 * winner of the race still has to write an answer nobody can overwrite from a stale snapshot. The
 * distinction is argued at `lockAsset` in `status.ts`: the constraint decides the contest, the lock
 * orders the bookkeeping that follows it.
 */
export class CustodyService {
  constructor(private readonly notify: NotifyService) {}

  /**
   * The one error a lost race produces, in every place a race can be lost.
   *
   * Actionable rather than apologetic: the reader's screen is now out of date, and the only thing
   * they can do about it is look again. `reason` is stable so a client could eventually say it in
   * the reader's own language; the message is the honest fallback until one does.
   */
  private static refuse(): KernError {
    return KernError.conflict(
      'Somebody changed who is holding this a moment before you did. Reload to see where it is now.',
      'inventory.custody.conflict',
    )
  }

  private async asset(tx: Tx, workspaceId: string, assetId: string): Promise<AssetRow> {
    const [row] = await tx
      .select()
      .from(assets)
      .where(and(eq(assets.workspaceId, workspaceId), eq(assets.id, assetId)))
    if (!row) throw KernError.notFound('Asset')
    // An archived asset is one the workspace has said it no longer tracks. Handing it to somebody
    // would make them answerable for something that is not in the register, and the timeline would
    // carry a handover after a retirement.
    if (row.archivedAt)
      throw KernError.conflict(
        'This item is archived. Restore it before handing it over.',
        'inventory.custody.archived',
      )
    return row
  }

  /** The period that has not been closed, if there is one. At most one exists, by construction. */
  async open(tx: Tx, workspaceId: string, assetId: string): Promise<PeriodRow | undefined> {
    const [row] = await tx
      .select()
      .from(custodyPeriods)
      .where(
        and(
          eq(custodyPeriods.workspaceId, workspaceId),
          eq(custodyPeriods.assetId, assetId),
          isNull(custodyPeriods.effectiveTo),
        ),
      )
      .limit(1)
    return row
  }

  /**
   * Every period for one asset, newest first.
   *
   * Capped rather than paged: the rows are bounded by how many times one item changed hands, which
   * is tens over its life. Ordered by `effective_from` and then by id, because a hand-on closes one
   * row and opens another at the same instant and the two would otherwise have no order between
   * them — the panel would show the handover before the return it replaced, at random.
   */
  async history(tx: Tx, workspaceId: string, assetId: string, limit: number): Promise<PeriodRow[]> {
    return tx
      .select()
      .from(custodyPeriods)
      .where(and(eq(custodyPeriods.workspaceId, workspaceId), eq(custodyPeriods.assetId, assetId)))
      .orderBy(desc(custodyPeriods.effectiveFrom), desc(custodyPeriods.id))
      .limit(limit)
  }

  /**
   * Close the open period at `at`, or refuse.
   *
   * `and effective_to is null` in the predicate is the optimistic guard: under READ COMMITTED a
   * concurrent close blocks this statement, and when it resumes the row no longer matches, so zero
   * rows come back rather than a second close silently overwriting the first one's timestamp.
   */
  private async close(tx: Tx, workspaceId: string, periodId: string, at: Date): Promise<PeriodRow> {
    const [row] = await tx
      .update(custodyPeriods)
      .set({ effectiveTo: at })
      .where(
        and(
          eq(custodyPeriods.workspaceId, workspaceId),
          eq(custodyPeriods.id, periodId),
          isNull(custodyPeriods.effectiveTo),
        ),
      )
      .returning()
    if (!row) throw CustodyService.refuse()
    return row
  }

  private async openPeriod(
    tx: Tx,
    workspaceId: string,
    assetId: string,
    userId: string,
    note: string | null,
    actorId: string | null,
    at: Date,
  ): Promise<PeriodRow> {
    try {
      const [row] = await tx
        .insert(custodyPeriods)
        .values({
          id: uuidv7(),
          workspaceId,
          assetId,
          userId,
          note,
          effectiveFrom: at,
          createdBy: actorId,
        })
        .returning()
      return row!
    } catch (err) {
      // The constraint bit: another transaction opened a period for this asset between our read and
      // our insert. Anything else is a real fault and must not be disguised as a lost race.
      if (violated(err, NO_OVERLAP)) throw CustodyService.refuse()
      throw err
    }
  }

  /**
   * The three denormalised columns, brought into step inside the same transaction.
   *
   * **`status` is not `userId ? 'assigned' : 'in_stock'`, and that line is what this comment is
   * about.** An item can be at a repairer *and* assigned to somebody — the repair does not release
   * whoever is answerable for it — so a handover that wrote `assigned` unconditionally would
   * announce a laptop as back in the office while it was still in the workshop. Both facts are read
   * and `deriveStatus` decides; the rule is argued in full in `status.ts`.
   *
   * **The asset row is locked before the repair state is read, and the order is the point.** Without
   * it a repair completing in another transaction is invisible here and this handover's status is
   * derived from a snapshot that has already stopped being true — the two writes then interleave
   * into a status matching neither. See `lockAsset`.
   *
   * The lock is also what makes `assets.archive`'s refusal real rather than advisory. Archiving
   * reads "nobody is holding it" under the same lock, so a handover racing an archive is ordered
   * against it: whichever gets the lock second sees what the first committed, and the re-check below
   * is what turns that into a refusal instead of an archived asset with an open custody period.
   *
   * @param repairsOn whether the workspace records repairs, read before the transaction opened.
   * A workspace that has switched the capability off has no `under_repair`, because the procedure
   * that would end one answers 404 — `deriveStatus` argues it in full, and this is one of the two
   * write paths that lets an asset out of a status nothing else could move it out of.
   */
  private async stamp(
    tx: Tx,
    workspaceId: string,
    assetId: string,
    userId: string | null,
    at: Date | null,
    repairsOn: boolean,
  ): Promise<AssetRow> {
    const locked = await lockAsset(tx, workspaceId, assetId)
    /**
     * Re-read under the lock, because the check in `asset()` was made against a snapshot an archive
     * committed a moment later could already have replaced.
     *
     * **Only when somebody is being *given* the item, and that is a narrowing rather than an escape
     * hatch.** A return never reaches this branch with an archived row at all: `return` calls
     * `asset()` first, and `asset()` refuses an archived asset outright, whichever verb asked. The
     * condition is here because a *return* has nothing to race — it can only ever leave the asset
     * unheld — so re-checking it would be a refusal with no state behind it. This comment used to
     * claim the opposite, that a return on an archived asset is deliberately allowed so an item that
     * had reached the impossible state could be undone; it is not allowed, it never was, and the
     * lock in `assets.archive` is what makes that state unreachable rather than merely rare.
     */
    if (userId !== null && locked.archivedAt)
      throw KernError.conflict(
        'This item is archived. Restore it before handing it over.',
        'inventory.custody.archived',
      )
    /**
     * Nor can a lost or retired item be *given* to anybody — handing over a thing nobody can find
     * is a handover nobody performed, and a retired one is out of service. A *return* is allowed
     * through, deliberately: the person answerable for a lost laptop has to be able to stop being
     * answerable for it, which is the honest end of that story.
     */
    if (userId !== null && dispositionOf(locked))
      throw KernError.conflict(
        locked.disposition === 'lost'
          ? 'This item is marked lost. Reinstate it before handing it over.'
          : 'This item is retired. Reinstate it before handing it over.',
        'inventory.custody.disposed',
      )
    const status = deriveStatus({
      custodianUserId: userId,
      awayForRepair: await awayForRepair(tx, workspaceId, assetId, repairsOn),
      disposition: dispositionOf(locked),
    })
    const [row] = await tx
      .update(assets)
      .set({
        custodianUserId: userId,
        custodySince: at,
        status,
        updatedAt: new Date(),
      })
      .where(and(eq(assets.workspaceId, workspaceId), eq(assets.id, assetId)))
      .returning()
    if (!row) throw KernError.notFound('Asset')
    return row
  }

  /**
   * The latest instant this asset's custody trail already reaches.
   *
   * The end of the most recent closed period, or the start of the open one. One row answers it
   * because the periods for an asset cannot overlap — that is what `inventory_custody_no_overlap`
   * enforces — so the row that starts last also ends last.
   */
  private async boundary(tx: Tx, workspaceId: string, assetId: string): Promise<Date | null> {
    const [row] = await tx
      .select({ from: custodyPeriods.effectiveFrom, to: custodyPeriods.effectiveTo })
      .from(custodyPeriods)
      .where(and(eq(custodyPeriods.workspaceId, workspaceId), eq(custodyPeriods.assetId, assetId)))
      .orderBy(desc(custodyPeriods.effectiveFrom), desc(custodyPeriods.id))
      .limit(1)
    return row ? (row.to ?? row.from) : null
  }

  /**
   * The instant this change happens, for both halves of it.
   *
   * One value, so the period that closes and the period that opens abut exactly: `'[)'` ranges
   * `[…, at)` and `[at, …)` do not overlap, where two `now()` calls a microsecond apart would leave
   * a gap during which the asset was held by nobody.
   *
   * **It is a millisecond past the trail's own end, not `now()`, and both halves of that are a
   * defect this replaced.**
   *
   * - `max(now, open.effectiveFrom)` produced a **zero-length period** whenever the two were equal,
   *   which two handovers inside one millisecond make them — a JS `Date` resolves no finer. `[t, t)`
   *   is empty, an empty range overlaps nothing, so the exclusion constraint waves it through and
   *   the trail permanently records somebody holding the item for no time at all. Anybody reading
   *   "who had this in March" gets a name that was never true. Strictly after the boundary, there
   *   is no such row to write.
   * - `assign` used plain `now()`, which a clock that steps backwards puts *before* the end of the
   *   last closed period — so the new period overlapped a finished one, Postgres refused it with
   *   `23P01`, and the person was told "somebody changed who is holding this a moment before you
   *   did. Reload." Nobody had; reloading changes nothing; the handover is refused again every time.
   *   Reading the trail's own end rather than the clock makes that unreachable instead of merely
   *   better explained: the next period always starts after the last one ended, whatever the clock
   *   says.
   *
   * `now` still wins whenever it is ahead, which is every ordinary case — this only ever moves the
   * instant forward, never back, so it cannot manufacture a period that starts before its asset was
   * bought.
   */
  private async instant(tx: Tx, workspaceId: string, assetId: string): Promise<Date> {
    const boundary = await this.boundary(tx, workspaceId, assetId)
    return new Date(Math.max(Date.now(), boundary ? boundary.getTime() + TICK_MS : 0))
  }

  /**
   * Hand a free item to a member.
   *
   * Refuses when somebody already has it, rather than quietly taking it off them: `transfer` is the
   * procedure that means "hand it on", and collapsing the two would make a mistyped assignment
   * indistinguishable from a deliberate handover in the timeline everyone reads afterwards.
   */
  async assign(
    tx: Tx,
    workspaceId: string,
    actorId: string | null,
    assetId: string,
    userId: string,
    note: string | null,
    repairsOn: boolean,
  ): Promise<CustodyWritten> {
    // Called for its two refusals — a row in another workspace is a 404, an archived one a
    // conflict — and not for the row, which `stamp` returns below in its post-handover shape.
    await this.asset(tx, workspaceId, assetId)
    const open = await this.open(tx, workspaceId, assetId)
    if (open)
      throw KernError.conflict(
        open.userId === userId
          ? 'They are already holding this item.'
          : 'Somebody else is holding this item. Hand it on, or take it back first.',
        'inventory.custody.already_held',
      )

    const at = await this.instant(tx, workspaceId, assetId)
    const period = await this.openPeriod(tx, workspaceId, assetId, userId, note, actorId, at)
    const row = await this.stamp(tx, workspaceId, assetId, userId, at, repairsOn)

    const activity: HistoryInput = {
      workspaceId,
      assetId,
      actorId,
      action: 'assigned',
      data: { userId, ...(note ? { note } : {}) },
    }
    await this.notify.history(tx, activity)
    return {
      asset: row,
      period,
      userId,
      previousUserId: null,
      activity,
      // Never the person doing the handing: telling somebody what they just did is the notification
      // everybody switches the type off over.
      notifyUserId: userId === actorId ? null : userId,
    }
  }

  /**
   * Hand it straight on. One transaction, not a return followed by an assign.
   *
   * Two calls would leave the asset `in_stock` with no custodian in between — visible to anybody
   * reading the list at that moment, and permanently visible in the timeline as a return nobody
   * performed and a stock period nobody spent.
   */
  async transfer(
    tx: Tx,
    workspaceId: string,
    actorId: string | null,
    assetId: string,
    userId: string,
    note: string | null,
    repairsOn: boolean,
  ): Promise<CustodyWritten> {
    await this.asset(tx, workspaceId, assetId)
    const open = await this.open(tx, workspaceId, assetId)
    if (!open)
      throw KernError.conflict(
        'Nobody is holding this item, so there is nothing to hand on. Assign it instead.',
        'inventory.custody.not_held',
      )
    if (open.userId === userId)
      throw KernError.conflict('They are already holding this item.', 'inventory.custody.already_held')

    const at = await this.instant(tx, workspaceId, assetId)
    await this.close(tx, workspaceId, open.id, at)
    const period = await this.openPeriod(tx, workspaceId, assetId, userId, note, actorId, at)
    const row = await this.stamp(tx, workspaceId, assetId, userId, at, repairsOn)

    const activity: HistoryInput = {
      workspaceId,
      assetId,
      actorId,
      action: 'transferred',
      data: { userId, previousUserId: open.userId, ...(note ? { note } : {}) },
    }
    await this.notify.history(tx, activity)
    return {
      asset: row,
      period,
      userId,
      previousUserId: open.userId,
      activity,
      notifyUserId: userId === actorId ? null : userId,
    }
  }

  /** Take it back. Closes the open period and puts the item back in stock. */
  async return(
    tx: Tx,
    workspaceId: string,
    actorId: string | null,
    assetId: string,
    note: string | null,
    repairsOn: boolean,
  ): Promise<CustodyWritten> {
    await this.asset(tx, workspaceId, assetId)
    const open = await this.open(tx, workspaceId, assetId)
    if (!open)
      throw KernError.conflict(
        'Nobody is holding this item, so there is nothing to take back.',
        'inventory.custody.not_held',
      )

    const at = await this.instant(tx, workspaceId, assetId)
    await this.close(tx, workspaceId, open.id, at)
    const row = await this.stamp(tx, workspaceId, assetId, null, null, repairsOn)

    const activity: HistoryInput = {
      workspaceId,
      assetId,
      actorId,
      action: 'returned',
      data: { previousUserId: open.userId, ...(note ? { note } : {}) },
    }
    await this.notify.history(tx, activity)
    return {
      asset: row,
      period: null,
      userId: null,
      previousUserId: open.userId,
      activity,
      // A return is not news to anybody: the person who had it knows they handed it back, and the
      // person taking it back is the one making the call.
      notifyUserId: null,
    }
  }
}
