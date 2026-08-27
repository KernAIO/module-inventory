import { KernError, type Kernel, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, asc, desc, eq, ilike, isNull, lt, or, sql } from 'drizzle-orm'
import { alias, type PgColumn } from 'drizzle-orm/pg-core'
import type {
  AssetCreateInput,
  AssetHistoryEntry,
  Asset as AssetModel,
  AssetPatchInput,
  AssetSort,
} from '../../contract/models.js'
import { InventorySettings } from '../../contract/settings.js'
import { assetHistory, assets, categories, counters } from '../schema.js'
import { decodeMark, decodeSeqMark, encodeMark, encodeSeqMark } from './cursor.js'
import type { HistoryInput, NotifyService } from './notify.js'
import { openRepairId } from './status.js'

type Row = typeof assets.$inferSelect

/**
 * What a mutation wrote, and what may only leave the module once it has committed.
 *
 * `asset_history` is written inside the caller's transaction and is authoritative; the mirror of it
 * in core's activity feed is not, and used to be fired off with `void` while the transaction was
 * still open. A rollback then left the workspace's feed showing an event for an id that does not
 * exist. Everything else this module announces — the event, the realtime change — already waits for
 * the commit, so the activity record is handed back here and flushed beside them.
 */
export interface Written {
  row: Row
  /** `null` when nothing happened worth recording, which is what an update that changed nothing is. */
  activity: HistoryInput | null
}

/** How this workspace spells an asset tag. Read before the transaction opens — see `codeFormat`. */
export interface CodeFormat {
  prefix: string
  pad: number
}

/** The wire shape: drizzle gives Date objects for timestamps, the contract promises ISO strings. */
export function toAsset(row: Row): AssetModel {
  return {
    id: row.id,
    workspaceId: row.workspaceId as AssetModel['workspaceId'],
    code: row.code,
    name: row.name,
    description: row.description,
    categoryId: row.categoryId,
    status: row.status as AssetModel['status'],
    custodianUserId: row.custodianUserId,
    custodySince: row.custodySince?.toISOString() ?? null,
    serialNumber: row.serialNumber,
    location: row.location,
    purchasedOn: row.purchasedOn ?? null,
    purchasedFrom: row.purchasedFrom,
    priceMinor: row.priceMinor,
    currency: row.currency,
    warrantyUntil: row.warrantyUntil ?? null,
    photoFileId: row.photoFileId,
    custom: row.custom ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  }
}

/**
 * The wire shape of one timeline entry. Drizzle's `jsonb` columns are nullable in the row and never
 * null in the contract — `changes: []` and `data: {}` are what "nothing to say" looks like to a
 * screen, where `null` is one more thing every caller has to remember to handle.
 */
export function toHistoryEntry(row: typeof assetHistory.$inferSelect): AssetHistoryEntry {
  return {
    id: row.id,
    assetId: row.assetId,
    actorId: row.actorId,
    action: row.action,
    changes: row.changes ?? [],
    data: (row.data as Record<string, unknown> | null) ?? {},
    occurredAt: row.occurredAt.toISOString(),
  }
}

/**
 * `%`, `_` and `\` are pattern syntax to `ilike`, not text.
 *
 * Unescaped, a search for `50%` matched every row in the workspace and a search for `_hair` matched
 * "Chair" — both of which read as a broken search rather than as a clever one. Escaped rather than
 * stripped: somebody typing a per-cent sign means the character.
 */
const contains = (q: string) => `%${q.replace(/[\\%_]/g, '\\$&')}%`

/**
 * The one ordering a timeline has, named rather than left as a literal.
 *
 * The cursor codec binds a bookmark to the sort it was issued under and refuses it under any other,
 * so a timeline needs a name for its sort even while there is only one — and the day a second one
 * exists, every cursor already in a browser tab is refused rather than misread.
 */
const HISTORY_SORT = 'recent'

/** Which column an ordering sorts on, for the list itself and for the bookmarked row alike. */
const sortKey = <T extends { id: PgColumn; name: PgColumn; code: PgColumn }>(t: T, sort: AssetSort) =>
  sort === 'name' ? t.name : sort === 'code' ? t.code : t.id

export interface ListInput {
  workspaceId: string
  limit: number
  cursor?: string
  q?: string
  categoryId?: string
  status?: string
  custodianUserId?: string
  archived: boolean
  sort: AssetSort
}

export class AssetService {
  constructor(
    private readonly kernel: Kernel,
    private readonly notify: NotifyService,
  ) {}

  /**
   * How this workspace spells an asset tag.
   *
   * **Called before the transaction opens, never inside one.** `kernel.settings.module` is a
   * `core.settings.getModule` call over the broker, and awaiting a remote service while holding a
   * pooled connection *and* the counter row lock is two failures waiting: the pool starves under
   * concurrent creates, and a create fails outright whenever core is briefly away — which is the
   * one thing `NotifyService`'s own docblock says a mutation here must never do.
   */
  async codeFormat(workspaceId: string): Promise<CodeFormat> {
    const settings = await this.kernel.settings.module(workspaceId, 'inventory', InventorySettings)
    return { prefix: settings.assetCodePrefix, pad: settings.assetCodePad }
  }

  /**
   * The next asset tag for a workspace.
   *
   * One narrow row per workspace and key, incremented under the insert's conflict lock — two
   * concurrent creates each read the value their own statement returned, so codes stay unique
   * without a retry loop. `INV-0042`, because people say asset tags out loud. Nothing in here
   * leaves the database, which is what keeps the lock short.
   */
  async nextCode(tx: Tx, workspaceId: string, format: CodeFormat): Promise<string> {
    const [row] = await tx
      .insert(counters)
      .values({ workspaceId, key: 'asset_code', value: 1 })
      .onConflictDoUpdate({
        target: [counters.workspaceId, counters.key],
        set: { value: sql`${counters.value} + 1` },
      })
      .returning()
    return `${format.prefix}${String(row!.value).padStart(format.pad, '0')}`
  }

  async list(tx: Tx, input: ListInput): Promise<{ items: AssetModel[]; nextCursor: string | null }> {
    const filters = [eq(assets.workspaceId, input.workspaceId)]
    if (input.q) {
      // A code is something somebody reads off a sticker; matching name, code and serial loosely
      // matters more than word-splitting here. Full-text arrives with the core indexer.
      const pattern = contains(input.q)
      filters.push(
        or(
          ilike(assets.name, pattern),
          ilike(assets.code, pattern),
          ilike(sql`coalesce(${assets.serialNumber}, '')`, pattern),
        )!,
      )
    }
    if (input.categoryId) filters.push(eq(assets.categoryId, input.categoryId))
    if (input.status) filters.push(eq(assets.status, input.status))
    if (input.custodianUserId) filters.push(eq(assets.custodianUserId, input.custodianUserId))
    if (!input.archived) filters.push(isNull(assets.archivedAt))

    /**
     * `recent` sorts by id rather than by `created_at`: ids are uuidv7, so they carry the clock, and
     * one indexed unique column is a cheaper and unambiguous page boundary than a timestamp two rows
     * can share. Ordered to the millisecond and no finer — the kernel's `uuidv7()` fills its last
     * ten bytes from `randomUUID()` with no counter — so two assets created inside one millisecond
     * come back in a stable but arbitrary order relative to each other.
     *
     * **The timeline deliberately stopped accepting that and this list has not**, so the difference
     * is worth stating rather than leaving as an inconsistency. `asset_history` is a record somebody
     * argues from, and a millisecond there holds a create and its own first entry, so an arbitrary
     * order is a lie about causation — it has a sequence of its own now (`schema.ts`, `seq`). A list
     * is an ordering of things a person is browsing: nothing hangs on which of two assets imported
     * in the same millisecond is shown first, and paging stays gapless either way because the id is
     * unique. If that ever stops being true — a bulk import whose order somebody relies on — the
     * fix is the same sequence, not a timestamp: `created_at` defaults to the *transaction's*
     * `now()`, so one import shares it exactly.
     *
     * It is fatal for a test that expects creation order; see `inventory.int.test.ts`.
     */
    const column = sortKey(assets, input.sort)
    const descending = input.sort === 'recent'

    if (input.cursor) {
      const mark = decodeMark(input.cursor, input.sort)
      /**
       * The sort key comes back out of the bookmarked row rather than out of the cursor, which is
       * what keeps the cursor small and stops it disagreeing with the row it names. Scoped by
       * `workspace_id` as well as by id, so a cursor cannot be used to probe another workspace's
       * ordering — this module reaches the database as a superuser in `core`, with RLS bypassed.
       *
       * A row deleted between two pages leaves the subquery empty, the row comparison NULL and the
       * page empty: the list simply ends. That is deliberate, and preferred to a 400 — somebody
       * else archiving a row while you read is an ordinary race, not a malformed request, and an
       * error toast on "Load more" would be a worse answer than a list that has run out.
       */
      const marker = alias(assets, 'page_marker')
      const bookmarked = tx
        .select({ key: sortKey(marker, input.sort), id: marker.id })
        .from(marker)
        .where(and(eq(marker.id, mark.i), eq(marker.workspaceId, input.workspaceId)))
      filters.push(
        descending
          ? sql`(${column}, ${assets.id}) < (${bookmarked})`
          : sql`(${column}, ${assets.id}) > (${bookmarked})`,
      )
    }

    const order = descending ? [desc(column), desc(assets.id)] : [asc(column), asc(assets.id)]

    const rows = await tx
      .select()
      .from(assets)
      .where(and(...filters))
      .orderBy(...order)
      .limit(input.limit + 1)

    const items = rows.slice(0, input.limit)
    const last = items.at(-1)
    const nextCursor = rows.length > input.limit && last ? encodeMark({ i: last.id, s: input.sort }) : null
    return { items: items.map(toAsset), nextCursor }
  }

  /**
   * The asset's own timeline, newest first, paged on the sequence the entries carry.
   *
   * **The ordering is `seq`, not `occurred_at` and not the id**, and the middle one of those three
   * is the interesting correction.
   *
   * `occurred_at` was never a candidate: it defaults to `now()`, which is the *transaction*
   * timestamp, so `create` writes the asset and its `created` entry with the same value and a page
   * boundary between two entries that share a sort key repeats one and drops the other.
   *
   * The id looked like the answer and was only half of one. A uuidv7 is unique, so paging on it is
   * gapless — but the kernel's `uuidv7()` carries the clock only to the millisecond and fills the
   * rest from `randomUUID()` with no counter, so two entries written inside one millisecond sort by
   * ten random bytes. Stable, so nothing was ever dropped or repeated; and arbitrary, so a timeline
   * could show "Bruno removed the file" above "Bruno added the file". `seq` is a sequence: strictly
   * increasing whatever the clock does, at whatever rate. `schema.ts` argues it at the column.
   *
   * The comparison is a single column because the sort key *is* the bookmark, so there is no
   * bookmarked-row subquery here. The bookmark is still checked as a bounded positive integer and
   * still bound to the sort it was issued under, because that is the codec's job and not this
   * query's.
   */
  async history(
    tx: Tx,
    workspaceId: string,
    assetId: string,
    input: { limit: number; cursor?: string },
  ): Promise<{ items: AssetHistoryEntry[]; nextCursor: string | null }> {
    // 404 before paging: a timeline for an asset in another workspace must not answer with an
    // empty list, which reads as "nothing has happened to it" rather than "it is not yours".
    await this.get(tx, workspaceId, assetId)

    const filters = [eq(assetHistory.workspaceId, workspaceId), eq(assetHistory.assetId, assetId)]
    if (input.cursor) filters.push(lt(assetHistory.seq, decodeSeqMark(input.cursor, HISTORY_SORT).n))

    const rows = await tx
      .select()
      .from(assetHistory)
      .where(and(...filters))
      .orderBy(desc(assetHistory.seq))
      .limit(input.limit + 1)

    const items = rows.slice(0, input.limit)
    const last = items.at(-1)
    const nextCursor =
      rows.length > input.limit && last ? encodeSeqMark({ n: last.seq, s: HISTORY_SORT }) : null
    return { items: items.map(toHistoryEntry), nextCursor }
  }

  /**
   * A category id in a request is a claim about a row in this workspace, and it is checked before
   * it is stored.
   *
   * The same defect `photoFileId` had, one field over: `assets.create` and `assets.update` took
   * `categoryId` on trust, so any uuid at all went into the column. Two things follow from that,
   * and neither is theoretical. An id belonging to **another workspace** files an asset under a
   * category this one cannot see, name or unfile — the picker resolves names from its own
   * `categories.list`, so the field renders blank and the filter it sits behind matches nothing
   * anybody can select. An id belonging to **nobody** does the same thing with no other workspace
   * involved. Either way the register holds a reference to a row that is not there, which is
   * exactly the state `categories.archive` exists to prevent from the other end.
   *
   * **Checked inside the caller's transaction, unlike `checkPhoto`.** A file lives in core and has
   * to be asked for over the broker, so that check happens before a connection is taken — the rule
   * `codeFormat` documents. A category is this module's own table one join away, so the honest
   * place for it is the transaction that writes the row: it costs one indexed read, and it cannot
   * be raced by somebody deleting the category, because nothing deletes one.
   *
   * An **archived** category is deliberately allowed. Archiving takes it out of every picker and
   * leaves every asset already filed under it still naming it; refusing it here would mean an edit
   * to an asset's location failed because of a category somebody tidied away last year, and it
   * would make re-filing a batch of assets under an old category impossible for no gain.
   */
  private async requireCategory(tx: Tx, workspaceId: string, categoryId: string): Promise<void> {
    const [row] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.workspaceId, workspaceId), eq(categories.id, categoryId)))
    if (!row) throw KernError.badRequest('That category is not one this workspace has.')
  }

  async get(tx: Tx, workspaceId: string, assetId: string): Promise<Row> {
    const [row] = await tx
      .select()
      .from(assets)
      .where(and(eq(assets.workspaceId, workspaceId), eq(assets.id, assetId)))
    if (!row) throw KernError.notFound('Asset')
    return row
  }

  async create(
    tx: Tx,
    workspaceId: string,
    actorId: string | null,
    input: AssetCreateInput,
    format: CodeFormat,
  ): Promise<Written> {
    if (input.categoryId) await this.requireCategory(tx, workspaceId, input.categoryId)
    const [row] = await tx
      .insert(assets)
      .values({
        id: uuidv7(),
        workspaceId,
        code: await this.nextCode(tx, workspaceId, format),
        name: input.name,
        description: input.description,
        categoryId: input.categoryId ?? null,
        serialNumber: input.serialNumber ?? null,
        location: input.location ?? null,
        purchasedFrom: input.purchasedFrom ?? null,
        purchasedOn: input.purchasedOn ?? null,
        warrantyUntil: input.warrantyUntil ?? null,
        priceMinor: input.priceMinor ?? null,
        currency: input.currency ?? null,
        photoFileId: input.photoFileId ?? null,
      })
      .returning()
    const activity: HistoryInput = { workspaceId, assetId: row!.id, actorId, action: 'created' }
    await this.notify.history(tx, activity)
    return { row: row!, activity }
  }

  /** Fields a person edits directly, and therefore the fields the timeline reports a diff for. */
  private static readonly EDITABLE = [
    'name',
    'description',
    'categoryId',
    'serialNumber',
    'location',
    'purchasedFrom',
    'purchasedOn',
    'warrantyUntil',
    'priceMinor',
    'currency',
    'photoFileId',
  ] as const

  async update(
    tx: Tx,
    workspaceId: string,
    actorId: string | null,
    assetId: string,
    input: AssetPatchInput,
  ): Promise<Written> {
    // Before the row is locked, because a refusal here has nothing to do with this asset and
    // holding a row lock across a check that can throw is a lock held for no reason. `undefined`
    // means the patch never mentioned a category and `null` means "unfile it"; neither is an id.
    if (input.categoryId) await this.requireCategory(tx, workspaceId, input.categoryId)

    const [prev] = await tx
      .select()
      .from(assets)
      .where(and(eq(assets.workspaceId, workspaceId), eq(assets.id, assetId)))
      .for('update')
    if (!prev) throw KernError.notFound('Asset')

    // `undefined` means "not mentioned"; `null` means "clear it". Collapsing the two is how an
    // edit of one field quietly wipes the others.
    const patch: Record<string, unknown> = { updatedAt: new Date() }
    for (const field of AssetService.EDITABLE) {
      const value = (input as Record<string, unknown>)[field]
      patch[field] = value !== undefined ? (value ?? null) : prev[field]
    }

    /**
     * A new warranty date earns a new notice.
     *
     * `warranty_notified_at` is the marker that stops the sweep saying the same thing every morning
     * for a month; left alone here, extending a warranty by two years would mean nobody is ever told
     * about the new date, because the row is already marked. Cleared only when the date itself
     * moved — an edit to the name must not re-arm a notice somebody has already had.
     */
    if (patch.warrantyUntil !== prev.warrantyUntil) patch.warrantyNotifiedAt = null

    // Filtered by workspace as well as by id. The `select … for update` three statements up already
    // carries the predicate, so this is not reachable today — but `core` connects as a superuser
    // with RLS bypassed, which makes the predicate in the statement the only barrier there is. A
    // barrier that holds only because of what another statement happens to do is not one.
    const [row] = await tx
      .update(assets)
      .set(patch)
      .where(and(eq(assets.workspaceId, workspaceId), eq(assets.id, assetId)))
      .returning()

    const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v) ?? null
    const changes = AssetService.EDITABLE.filter((f) => iso(patch[f]) !== iso(prev[f])).map((f) => ({
      field: f,
      from: iso(prev[f]),
      to: iso(patch[f]),
    }))
    if (changes.length === 0) return { row: row!, activity: null }

    const activity: HistoryInput = { workspaceId, assetId, actorId, action: 'updated', changes }
    await this.notify.history(tx, activity)
    return { row: row!, activity }
  }

  /**
   * @param repairsOn whether the workspace records repairs, read before the transaction opened.
   * The "it is away for repair" refusal below tells somebody to go and use `repairs.complete`, and
   * that procedure answers 404 in a workspace with the capability off — so the refusal would be an
   * instruction to open a door that is not there, and the asset could never leave the register.
   */
  async archive(
    tx: Tx,
    workspaceId: string,
    actorId: string | null,
    assetId: string,
    archived: boolean,
    repairsOn: boolean,
  ): Promise<Written> {
    /**
     * **Locked before either refusal is decided, because both of them are about a race.**
     *
     * The two checks below used to read the facts with a plain select, so the state they call
     * impossible was reachable by simply doing the two things at once: an archive and a handover
     * each read "nobody is holding it", both were allowed, and the register was left with an
     * archived asset and an open custody period — the timeline showing a handover that never ended,
     * and "what is Ada still holding?" quietly not counting it, because that question excludes
     * archived rows. A check whose answer another transaction may already have changed is not a
     * check; it is a comment.
     *
     * The lock is the same one `CustodyService.stamp` and `RepairService.restamp` take before they
     * write `status`, which is what makes the ordering complete rather than one-sided: whichever
     * transaction gets it second re-reads what the first committed, so an archive that arrives
     * first makes the handover refuse, and a handover that arrives first makes the archive refuse.
     * `lockAsset` in `status.ts` argues it in full.
     */
    const [locked] = await tx
      .select()
      .from(assets)
      .where(and(eq(assets.workspaceId, workspaceId), eq(assets.id, assetId)))
      .for('update')
    if (!locked) throw KernError.notFound('Asset')

    if (archived) {
      /**
       * An item somebody is holding cannot leave the register.
       *
       * Somebody is answerable for the thing; taking it out of the register does not make them not
       * answerable, it only stops anybody being able to find out. Two steps instead of one, and
       * both of them mean something.
       */
      if (locked.custodianUserId)
        throw KernError.conflict(
          'Somebody is still holding this item. Take it back before archiving it.',
          'inventory.asset.still_held',
        )

      /**
       * An item that is at a repairer cannot leave the register either, and for the same reason as
       * custody: money is committed and the thing is out of the building, so taking it out of the
       * register does not settle that — it only stops anybody being able to find out.
       *
       * It also keeps two counts that must agree from drifting. `stats.summary` reports
       * `byStatus.under_repair` from the cached status column, over live rows only, and
       * `outForRepair` from the repair rows themselves; an archived asset with an open repair
       * would appear in one and not the other, and neither number would be wrong.
       *
       * **Only while the workspace records repairs.** With the `repairs` capability off, this
       * refusal names a procedure that answers 404 — so it was not a two-step instruction, it was a
       * dead end: the repair could not be completed, so the asset could not be archived, so the
       * item was stuck in the register for as long as the capability stayed off. A refusal that
       * points at a door has to be withdrawn when the door is taken away. `stats.away` counts only
       * live assets for the same reason, so the two counts still cannot disagree.
       */
      const open = repairsOn ? await openRepairId(tx, workspaceId, assetId) : undefined
      if (open)
        throw KernError.conflict(
          'This item is away for repair. Log the repair as returned before archiving it.',
          'inventory.asset.under_repair',
        )
    }

    const [row] = await tx
      .update(assets)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(and(eq(assets.workspaceId, workspaceId), eq(assets.id, assetId)))
      .returning()
    if (!row) throw KernError.notFound('Asset')
    const activity: HistoryInput = {
      workspaceId,
      assetId,
      actorId,
      action: archived ? 'retired' : 'restored',
    }
    await this.notify.history(tx, activity)
    return { row, activity }
  }
}
