import type { core } from '@kernhq/contracts'
import type { Kernel, Tx } from '@kernhq/kernel'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { MODULE_ID } from '../../contract/models.js'
import { assets, categories } from '../schema.js'
import type { NotifyService } from './notify.js'

/** One page of the full reindex. Big enough to be worth a round trip, small enough to hold. */
const SCAN_BATCH = 500

/**
 * How an asset is referred to from outside this module.
 *
 * One function, because a search hit and a resolved `inventory:asset:<id>` reference have to be the
 * same thing — somebody who finds a laptop in the command palette and somebody who follows a link to
 * it from a chat message are looking at the same row and must see the same words for it.
 */
export const assetUrl = (assetId: string) => `/inventory?asset=${assetId}`
export const ASSET_ICON = 'briefcase'

/** The columns a document is built from, and the one join it needs. */
export interface IndexableAsset {
  asset: typeof assets.$inferSelect
  /** The category's name, resolved at read time — never copied into `assets`, so a rename lands. */
  categoryName: string | null
}

/**
 * What a person types into the command palette, and what an asset has to answer it with.
 *
 * An asset tag read off a sticker is the first of these — `INV-0042` is what somebody has in their
 * hand — so it leads the title, exactly as tracker leads with an issue key. The rest is everything
 * printed on or near the thing: its name, its serial number, where it is kept, and what the
 * workspace files it under.
 *
 * **The category is indexed by name, not by id.** "chair" finds every chair filed under Furniture
 * only if the word Furniture is in the document; an id in `attributes` is a filter, not a search
 * term. The cost is that renaming a category leaves its assets' documents naming the old word until
 * each one is next written, which is a staleness worth stating and not worth a workspace-wide
 * rewrite on every rename — `core.search.reindex` is the thing that fixes it, and it exists.
 *
 * `acl` is null: an asset is visible to anybody with `inventory.asset.view`, which is a workspace
 * permission and not a per-row one, so there is no narrower audience to name.
 */
export function assetSearchDocument(workspaceId: string, row: IndexableAsset): core.SearchDocument {
  const body = [row.asset.description, row.asset.serialNumber, row.asset.location, row.categoryName]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join('\n')
  return {
    workspaceId: workspaceId as core.SearchDocument['workspaceId'],
    object: { module: MODULE_ID, type: 'asset', id: row.asset.id },
    title: `${row.asset.code} ${row.asset.name}`,
    body: body || null,
    url: assetUrl(row.asset.id),
    icon: ASSET_ICON,
    acl: null,
    updatedAt: row.asset.updatedAt.toISOString(),
    attributes: {
      code: row.asset.code,
      status: row.asset.status,
      categoryId: row.asset.categoryId,
      custodianUserId: row.asset.custodianUserId,
    },
  }
}

/** The one select every read here makes: the asset, plus its category's current name. */
const withCategoryName = (tx: Tx) =>
  tx
    .select({ asset: assets, categoryName: categories.name })
    .from(assets)
    .leftJoin(
      categories,
      and(eq(categories.id, assets.categoryId), eq(categories.workspaceId, assets.workspaceId)),
    )

/**
 * Putting assets into the workspace-wide search index, and taking them out again.
 *
 * `NotifyService` has carried `index`/`unindex` since the module was written and nothing called
 * either, because `objectTypes` had been taken off the manifest — a declared type with no indexer
 * and no resolver renders a link to nothing, which reads to a person as a broken product rather
 * than as a feature that has not shipped. Both halves arrive together here.
 *
 * Every method is best-effort by way of `NotifyService`: an asset must not fail to save because the
 * core search service is briefly away. The register's own row is authoritative and a later
 * `core.search.reindex` repairs whatever was missed, which is exactly what that job is for.
 */
export class SearchService {
  constructor(
    private readonly kernel: Kernel,
    private readonly notify: NotifyService,
  ) {}

  /**
   * One asset as a document, or `null` for one the index should not hold.
   *
   * `null` for a row that is gone **and** for one that is archived, because the indexer treats null
   * as "remove this": an archived asset is one the workspace has said it no longer tracks, so
   * finding it in the command palette would offer a door to something deliberately put away.
   * Restoring it writes the row again, which reindexes it.
   */
  async load(workspaceId: string, assetId: string): Promise<core.SearchDocument | null> {
    return this.kernel.database.withWorkspace(workspaceId, async (tx) => {
      const [row] = await withCategoryName(tx)
        .where(and(eq(assets.workspaceId, workspaceId), eq(assets.id, assetId)))
        .limit(1)
      if (!row || row.asset.archivedAt) return null
      return assetSearchDocument(workspaceId, row)
    })
  }

  /**
   * Every live asset of a workspace, in pages, for a full reindex.
   *
   * Keyset by id rather than `offset`: a scan of a big workspace runs for a while, and an offset
   * walk over a table somebody is writing to repeats and drops rows. Ids are uuidv7 and unique, so
   * one column is a page boundary two rows cannot share — the same reasoning `assets.list` gives.
   *
   * One transaction per page rather than one for the whole scan: holding a pooled connection open
   * across a reindex of ten thousand rows is how a service runs out of connections doing
   * maintenance.
   */
  async *scan(workspaceId: string): AsyncIterable<core.SearchDocument> {
    let cursor: string | null = null
    for (;;) {
      const rows: IndexableAsset[] = await this.kernel.database.withWorkspace(workspaceId, (tx) =>
        withCategoryName(tx)
          .where(
            and(
              eq(assets.workspaceId, workspaceId),
              isNull(assets.archivedAt),
              cursor ? sql`${assets.id} > ${cursor}` : sql`true`,
            ),
          )
          .orderBy(assets.id)
          .limit(SCAN_BATCH),
      )
      if (!rows.length) return
      for (const row of rows) yield assetSearchDocument(workspaceId, row)
      cursor = rows.at(-1)?.asset.id ?? null
    }
  }

  /**
   * Bring the index into step with one asset, whichever direction that means.
   *
   * Called after the transaction has committed, never inside it — the index is another service's
   * table, and telling it about a row a rollback then took away cannot be retracted. It is the
   * reason `router.ts` announces from outside the transaction and this is announced beside the
   * event and the realtime change.
   */
  async reindex(workspaceId: string, assetId: string): Promise<void> {
    const document = await this.load(workspaceId, assetId).catch((err) => {
      this.kernel.log.warn(
        { err: err instanceof Error ? err.message : err, workspaceId, assetId },
        'inventory: could not read an asset to reindex it',
      )
      return undefined
    })
    if (document === undefined) return
    if (document) await this.notify.index([document])
    else await this.notify.unindex(workspaceId, 'asset', [assetId])
  }
}
