import { KernError, type Kernel, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, asc, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm'
import { alias, type PgColumn } from 'drizzle-orm/pg-core'
import type {
  AssetCreateInput,
  Asset as AssetModel,
  AssetPatchInput,
  AssetSort,
} from '../../contract/models.js'
import { InventorySettings } from '../../contract/settings.js'
import { assets, counters } from '../schema.js'
import type { HistoryInput, NotifyService } from './notify.js'

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
 * A page boundary, as the client sees it: **the bookmarked row's id, and the sort it was issued
 * under**. Nothing else — in particular not the sort key itself, which is what it used to carry.
 *
 * That earlier shape (`{k: <sort key>, i: <id>}`) was wrong three separate ways, each of them
 * reachable by anyone who could type into the address bar:
 *
 *   - **It could not be trusted.** `decode` checked only that `i` was a *string*, and `i` is
 *     interpolated into `(col, id) < ($1, $2::uuid)`. `{"k":"x","i":"not-a-uuid"}` therefore
 *     reached Postgres as a 22P02 nobody caught — an unhandled 500 and an error-level log line per
 *     request, at the 600-a-minute the rate limiter allows.
 *   - **It was not bound to its sort.** A cursor issued under `sort=recent` replayed under
 *     `sort=code` compared a uuid against a code, so page two came back equal to page one and
 *     "Load more" never ended.
 *   - **It was unbounded.** `sort=name` on a 200-character Persian name encoded to 602 characters,
 *     and `Cursor` in `@kernhq/contracts` is `max(512)` — so a long enough name broke "Load more"
 *     with a validation error, in exactly the locales least likely to be tested.
 *
 * Carrying the id alone and reading the sort key back from that row in SQL answers all three: the
 * cursor is a fixed ~60 characters whatever the name, a value that is not a uuid is refused before
 * it is anywhere near the database, and a cursor whose sort disagrees with the request is refused
 * rather than quietly misread. Base64 so nothing in the product is tempted to read it — it is a
 * bookmark, not an offset, and its shape is this file's business.
 */
interface Bookmark {
  i: string
  s: AssetSort
}
const encode = (b: Bookmark) => Buffer.from(JSON.stringify(b), 'utf8').toString('base64url')

/** Cheap and total, and it runs before the value can reach a `::uuid` cast. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function decode(cursor: string, sort: AssetSort): Bookmark {
  const refuse = () => KernError.badRequest('That page marker is not one this list issued')
  let parsed: Partial<Bookmark> | null
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<Bookmark> | null
  } catch {
    throw refuse()
  }
  if (typeof parsed?.i !== 'string' || !UUID.test(parsed.i)) throw refuse()
  // One comparison covers both a sort this list never issues and a sort it issued under a
  // *different* request. Either way the bookmark cannot be read against the ordering asked for,
  // and pretending otherwise is what made "Load more" loop for ever.
  if (parsed.s !== sort) throw refuse()
  return { i: parsed.i, s: sort }
}

/**
 * `%`, `_` and `\` are pattern syntax to `ilike`, not text.
 *
 * Unescaped, a search for `50%` matched every row in the workspace and a search for `_hair` matched
 * "Chair" — both of which read as a broken search rather than as a clever one. Escaped rather than
 * stripped: somebody typing a per-cent sign means the character.
 */
const contains = (q: string) => `%${q.replace(/[\\%_]/g, '\\$&')}%`

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

    // `recent` sorts by id rather than by `created_at`: ids are uuidv7, so they carry the clock,
    // and one indexed unique column is a cheaper and unambiguous page boundary than a timestamp
    // two rows can share. Ordered to the millisecond and no finer — the kernel's `uuidv7()` fills
    // its last ten bytes from `randomUUID()` with no counter — so two assets created inside one
    // millisecond come back in a stable but arbitrary order relative to each other. That is fine
    // for a list and fatal for a test that expects creation order; see `inventory.int.test.ts`.
    const column = sortKey(assets, input.sort)
    const descending = input.sort === 'recent'

    if (input.cursor) {
      const mark = decode(input.cursor, input.sort)
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
    const nextCursor = rows.length > input.limit && last ? encode({ i: last.id, s: input.sort }) : null
    return { items: items.map(toAsset), nextCursor }
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

  async archive(
    tx: Tx,
    workspaceId: string,
    actorId: string | null,
    assetId: string,
    archived: boolean,
  ): Promise<Written> {
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
