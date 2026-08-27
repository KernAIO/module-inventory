import type { Tx } from '@kernhq/kernel'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { AssetStatus, type InventoryStats } from '../../contract/models.js'
import { assets, repairs } from '../schema.js'

/**
 * The register in numbers.
 *
 * It exists because the assets page had no honest number to print. `assets.list` is keyset-paged and
 * never counts, so the count line said "50 assets" for a workspace with 214 of them and then "100
 * assets" after *Load more* — a number that is simply wrong, on the line whose whole job is to be
 * the number. A `count(*)` bolted onto every list page would be the expensive answer to that; one
 * cheap procedure the page calls once is the right one, and it also gives the dashboard card
 * something worth showing.
 *
 * **`total` counts what the list shows by default — live rows.** `archived` sits beside it rather
 * than inside it, because a count line that silently included archived rows would disagree with the
 * list underneath it.
 */
export class StatsService {
  /**
   * @param repairsOn whether this workspace has the `repairs` capability. Resolved by the caller
   * *before* the transaction opens, because it is a settings read over the broker.
   */
  async summary(tx: Tx, workspaceId: string, repairsOn: boolean): Promise<InventoryStats> {
    const [totals] = await tx
      .select({
        total: sql<number>`count(*) filter (where ${assets.archivedAt} is null)`.mapWith(Number),
        archived: sql<number>`count(*) filter (where ${assets.archivedAt} is not null)`.mapWith(Number),
        unassigned:
          sql<number>`count(*) filter (where ${assets.archivedAt} is null and ${assets.custodianUserId} is null)`.mapWith(
            Number,
          ),
      })
      .from(assets)
      .where(eq(assets.workspaceId, workspaceId))

    const grouped = await tx
      .select({ status: assets.status, n: sql<number>`count(*)`.mapWith(Number) })
      .from(assets)
      .where(and(eq(assets.workspaceId, workspaceId), isNull(assets.archivedAt)))
      .groupBy(assets.status)

    /**
     * Zero-filled over the whole enum, so a screen can render the set without asking which statuses
     * happen to exist in this workspace. A missing key and a zero look the same on a card and are
     * not the same thing to a `Record`.
     */
    const byStatus = Object.fromEntries(
      AssetStatus.options.map((status) => [status, 0]),
    ) as InventoryStats['byStatus']
    for (const row of grouped) if (row.status in byStatus) byStatus[row.status as AssetStatus] = row.n

    return {
      total: totals?.total ?? 0,
      archived: totals?.archived ?? 0,
      byStatus,
      outForRepair: repairsOn ? await this.away(tx, workspaceId) : null,
      unassigned: totals?.unassigned ?? 0,
    }
  }

  /**
   * How many live items are at a repairer, counted from the **repair rows** rather than from
   * `assets.status`.
   *
   * `byStatus.under_repair` is the same number, and deliberately arrives a different way: that one
   * reads the cached column every list filters on, this one reads the fact the column is derived
   * from. `deriveStatus` is what keeps them equal, and `inventory.int.test.ts` asserts they are —
   * which is a real check on the derivation rather than two ways of writing the same query.
   *
   * **Joined to `assets` for the live rows, which it did not used to be.** The old version leaned on
   * `AssetService.archive` refusing to retire an item that is away, so every open repair was assumed
   * to belong to a live asset. That refusal is now withdrawn while the workspace has the `repairs`
   * capability off — it named a procedure answering 404, and leaving it in place is what stranded
   * the asset — so an archived row with an open repair is reachable, and `byStatus.under_repair`
   * (live rows only) would have disagreed with this number the moment the capability came back on.
   * Two counts of one thing have to be counted over one set.
   */
  private async away(tx: Tx, workspaceId: string): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(repairs)
      .innerJoin(assets, and(eq(assets.id, repairs.assetId), eq(assets.workspaceId, repairs.workspaceId)))
      .where(and(eq(repairs.workspaceId, workspaceId), isNull(repairs.returnedOn), isNull(assets.archivedAt)))
    return row?.n ?? 0
  }
}
