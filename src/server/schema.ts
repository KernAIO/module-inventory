import { moduleSchema } from '@kernhq/kernel'
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * This module's tables, in its own Postgres schema.
 *
 * Two rules, neither optional:
 *
 * - every tenant table carries `workspace_id` and an index that starts with it;
 * - every tenant table gets a row-level security policy, hand-written in the migration, because
 *   drizzle-kit does not generate one. RLS is the last line — the API check is the first, and
 *   somebody will eventually write a query that skips it.
 */
export const schema = moduleSchema('inventory')

/** Local column factories, so the conventions stay in one place. */
const id = () => uuid('id').primaryKey().default(sql`uuidv7()`)
const ws = () => uuid('workspace_id').notNull()
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })
const created = () => ts('created_at').notNull().defaultNow()
const updated = () => ts('updated_at').notNull().defaultNow()

/**
 * Workspaces this module is switched on in, so scheduled work can find them.
 *
 * A cron handler starts with no workspace: it is woken by a clock, not by a request, so there is
 * nothing to derive a tenant from and no `withWorkspace` it could already be inside. Core knows the
 * answer and would give it (`core.workspaces.list`), but asking it every tick makes the sweeps fail
 * whenever core is briefly away — for a job whose whole point is to run unattended overnight. So the
 * module keeps the one fact it needs: an id, written when the module is switched on for a workspace
 * and when a workspace is created. `module-tracker` keeps the same table for the same reason.
 *
 * **It carries `workspace_id`, so it is a tenant table and has a policy like every other** — and the
 * one reader that cannot honour that policy is the enumeration itself, because `app.workspace_id` is
 * unset in a job by definition. That was left resting on "the connection is the schema's owner, and
 * an owner bypasses RLS", which is **false here**: every table in this schema carries `force row
 * level security`, and forcing it subjects the owner to the policies too. So `select workspace_id
 * from workspaces` with no workspace bound answered zero rows — not an error, not a warning, simply
 * nothing to sweep, every night, for ever.
 *
 * `0006_workspace_registry_read.sql` is the fix and it is scoped as narrowly as the problem: one
 * extra `for select` policy, on this table only, admitting a session that has **no** workspace bound.
 * A request-bound session still sees exactly its own row, and this table holds nothing but workspace
 * ids anyway — it is the module's own bookkeeping, not tenant data anybody reads. Added in `0004`,
 * because 0.2.0 is published.
 */
export const workspaces = schema.table('workspaces', {
  workspaceId: uuid('workspace_id').primaryKey(),
  createdAt: created(),
})

export const counters = schema.table(
  'counters',
  /** Per-workspace sequence sources (`asset_code`). Narrow on purpose: one row per key. */
  {
    workspaceId: ws(),
    key: text('key').notNull(),
    value: integer('value').notNull(),
  },
  /**
   * Composite, declared here rather than as two `.primaryKey()` columns.
   *
   * Column-level `.primaryKey()` twice reads like a compound key and is not one: drizzle emits
   * `PRIMARY KEY` on both columns and Postgres refuses the table outright — "multiple primary keys
   * for table are not allowed", SQLSTATE 42P16. The module's migration is the first thing the
   * kernel runs, so the failure is not a broken table but a service that will not boot.
   */
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
)

export const categories = schema.table(
  'categories',
  {
    id: id(),
    workspaceId: ws(),
    name: text('name').notNull(),
    order: integer('order').notNull().default(0),
    /**
     * Archived rather than deleted, and the reason is `assets.category_id`.
     *
     * There is no foreign key — a module keeps its joins inside its own schema and its ids plain —
     * so deleting a row here would leave every asset filed under it pointing at nothing. The
     * category column on the row would go blank and the timeline entry that says "category changed
     * to Laptops" would lose the word "Laptops": data destroyed by a settings screen, silently, and
     * with no way back. Archiving takes the category out of every picker and every filter and
     * leaves each asset able to say what it is.
     *
     * Added in `0002`, because 0.2.0 is published.
     */
    archivedAt: ts('archived_at'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    // Unique across archived rows too: two categories called "Laptops", one of them archived, is
    // two rows a picker cannot tell apart the moment somebody restores the second.
    uniqueIndex('inventory_categories_ws_name_uq').on(t.workspaceId, t.name),
    index('inventory_categories_ws_idx').on(t.workspaceId, t.order),
    /**
     * One live category per place, which the contract claims and nothing enforced until `0008`.
     *
     * **Partial, over the live rows only.** An archived category keeps the number it had when it was
     * archived and the next reorder renumbers a live row onto it — a collision nobody can see, since
     * an archived category is in no picker, no filter and no sequence. A total unique index would
     * refuse that entirely correct pair.
     */
    uniqueIndex('inventory_categories_ws_order_live_uq')
      .on(t.workspaceId, t.order)
      .where(sql`${t.archivedAt} is null`),
  ],
)

export const assets = schema.table(
  'assets',
  {
    id: id(),
    workspaceId: ws(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    categoryId: uuid('category_id'),
    /** `AssetStatus` in the contract. Text, not a pg enum: every other Kern module stores a
     * status this way, and an enum named `asset_status` in `public` is a type this module
     * leaves behind when it is removed. */
    status: text('status').notNull().default('in_stock'),
    /** Denormalized from `custody_periods`, which stays authoritative for history. */
    custodianUserId: uuid('custodian_user_id'),
    custodySince: ts('custody_since'),
    /**
     * `Disposition` in the contract: `lost` or `retired`, or null for an item still in service.
     *
     * Its own column rather than a value written into `status`, because `status` is a derivation
     * and this is a decision: the reconciliation sweep recomputes `status` from the facts, and a
     * decision has to be one of the facts it reads or the sweep would undo it. `deriveStatus` reads
     * it first. Text, not a pg enum, for the reason `status` gives.
     *
     * Both nullable and added in `0009`, so the image before this one reads the table straight
     * past them.
     */
    disposition: text('disposition'),
    dispositionAt: ts('disposition_at'),
    serialNumber: text('serial_number'),
    location: text('location'),
    purchasedOn: date('purchased_on'),
    purchasedFrom: text('purchased_from'),
    priceMinor: integer('price_minor'),
    currency: char('currency', { length: 3 }),
    warrantyUntil: date('warranty_until'),
    /**
     * When the warranty sweep last told somebody this one is about to run out.
     *
     * The idempotency row `kern-service` asks scheduled work for, as a column. A warranty falls
     * inside the notice window for every one of the thirty days before it expires, so a sweep with
     * no marker sends the same notice thirty times — and `groupKey` collapses that in the
     * notification centre while still sending thirty emails. Cleared by `assets.update` whenever
     * `warranty_until` itself moves, so extending a warranty earns a fresh notice at the new date.
     *
     * Nullable and added in `0004`, so the 0.2.0 image reads the table straight past it.
     */
    warrantyNotifiedAt: ts('warranty_notified_at'),
    photoFileId: uuid('photo_file_id'),
    /** Values for this workspace's own `field_defs`, keyed by their `key`. */
    custom: jsonb('custom').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: created(),
    updatedAt: updated(),
    archivedAt: ts('archived_at'),
  },
  (t) => [
    uniqueIndex('inventory_assets_ws_code_uq').on(t.workspaceId, t.code),
    index('inventory_assets_ws_created_idx').on(t.workspaceId, t.createdAt),
    index('inventory_assets_ws_status_idx').on(t.workspaceId, t.status),
    index('inventory_assets_ws_category_idx').on(t.workspaceId, t.categoryId),
    // "What is Ada holding?" — asked by the person, by the offboarding hook, and by a widget.
    index('inventory_assets_ws_custodian_idx')
      .on(t.workspaceId, t.custodianUserId)
      .where(sql`custodian_user_id is not null`),
    // The "what leaves warranty this month" scan, before a job makes it a widget's cheap query.
    index('inventory_assets_ws_warranty_idx')
      .on(t.workspaceId, t.warrantyUntil)
      .where(sql`warranty_until is not null`),
  ],
)

/**
 * Workspace-defined extra fields, copied from tracker's `field_defs` (which cannot be shared:
 * cross-schema joins are what the module boundary exists to prevent). The `key` **is** the key a
 * value lives under in `assets.custom`, hence unique per workspace whatever the category scope.
 *
 * Three columns here are in the table and not in the contract — `default_value`, `searchable` and
 * `show_in_list`. They shipped in `0000` ahead of any procedure, and the procedures that arrived
 * (`fields.*`) do not read them: a default is a value the form fills in, which is the form's job;
 * search and a list column are features with their own screens. Nullable or defaulted, so nothing
 * writes them and nothing is broken by their being there; they go one release after something
 * decides to use them or not.
 */
export const fieldDefs = schema.table(
  'field_defs',
  {
    id: id(),
    workspaceId: ws(),
    categoryId: uuid('category_id'),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** `FieldType` in the contract. Text, not a pg enum, for the reason `assets.status` gives. */
    type: text('type').notNull(),
    /** The choices of a `select` or `multiselect`, in order; empty for every other type. */
    options: jsonb('options').$type<string[]>(),
    defaultValue: jsonb('default_value'),
    required: boolean('required').notNull().default(false),
    searchable: boolean('searchable').notNull().default(false),
    showInList: boolean('show_in_list').notNull().default(false),
    order: integer('order').notNull().default(0),
    archivedAt: ts('archived_at'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex('inventory_field_defs_ws_key_uq').on(t.workspaceId, t.key),
    index('inventory_field_defs_ws_idx').on(t.workspaceId, t.order),
  ],
)

/**
 * Custody over time. Never updated in place — a change closes the open row and inserts a new one,
 * the way HR keeps employments. The exclusion constraint (hand-written migration) makes two open
 * periods for one asset impossible at the database level, not merely unlikely in the service.
 */
export const custodyPeriods = schema.table(
  'custody_periods',
  {
    id: id(),
    workspaceId: ws(),
    assetId: uuid('asset_id').notNull(),
    userId: uuid('user_id').notNull(),
    note: text('note'),
    effectiveFrom: ts('effective_from').notNull().defaultNow(),
    effectiveTo: ts('effective_to'),
    createdBy: uuid('created_by'),
    createdAt: created(),
  },
  (t) => [index('inventory_custody_ws_asset_idx').on(t.workspaceId, t.assetId, t.effectiveFrom)],
)

/**
 * Append-only. What changed, when, by whom — the timeline an asset page renders and the answer to
 * "who had this laptop before me". Written inside the caller's transaction; nothing edits or
 * deletes rows here, ever.
 */
export const assetHistory = schema.table(
  'asset_history',
  {
    id: id(),
    workspaceId: ws(),
    assetId: uuid('asset_id').notNull(),
    actorId: uuid('actor_id'),
    action: text('action').notNull(), // created | updated | assigned | transferred | returned | repair_logged | repair_completed | attachment_added | retired | restored
    changes: jsonb('changes').$type<{ field: string; from: unknown; to: unknown }[]>(),
    data: jsonb('data'),
    occurredAt: created(),
    /**
     * The order these entries actually happened in — a sequence, not a clock and not the id.
     *
     * **A uuidv7 is only ordered to the millisecond.** The kernel's `uuidv7()` puts the clock in
     * bytes 0-5 and fills bytes 6-15 from `randomUUID()` with no intra-millisecond counter, so two
     * entries written in the same millisecond sort by ten random bytes. That is *stable* for a
     * given set of rows, which is why keyset paging never dropped or repeated one and why the
     * defect hid for so long — what it produced instead was a timeline rendering "Bruno removed the
     * file" above "Bruno added the file". A register's whole value is that it says what happened in
     * the order it happened.
     *
     * `occurred_at` cannot stand in for it either: it defaults to `now()`, which is the
     * *transaction* timestamp, so a create and its first history row share it exactly.
     *
     * A sequence is exact rather than probabilistic — `nextval` is strictly increasing whatever the
     * clock does — and it is the one ordering key a module owns outright. Filled by the column
     * default, so nothing in the service has to remember it and the previous image's inserts get
     * one too. Added in `0007`.
     */
    seq: bigint('seq', { mode: 'number' }).notNull().default(sql`nextval('mod_inventory.asset_history_seq')`),
  },
  (t) => [
    index('inventory_asset_history_asset_idx').on(t.workspaceId, t.assetId, t.occurredAt),
    /**
     * Superseded by the index below, and left here on purpose.
     *
     * The timeline used to be keyset-paged by **id**, on the reasoning `assets.list` still gives for
     * `sort: 'recent'` — an id is uuidv7, so it carries the clock, and it is unique where
     * `occurred_at` is not. Unique it is; ordered it is only to the millisecond. `seq` replaced it.
     *
     * Dropping this is a schema change and a migration here only adds, so it goes one release from
     * now rather than in the one that stopped reading it. Added in `0002`.
     */
    index('inventory_asset_history_ws_asset_row_idx').on(t.workspaceId, t.assetId, t.id),
    /**
     * What `assets.history` pages on: one asset's entries, newest first, bounded by `seq`.
     *
     * Unique, because the sequence makes it so and saying so lets Postgres stop at the first match
     * for a cursor. Added in `0007`.
     */
    uniqueIndex('inventory_asset_history_ws_asset_seq_uq').on(t.workspaceId, t.assetId, t.seq),
  ],
)

export const repairs = schema.table(
  'repairs',
  {
    id: id(),
    workspaceId: ws(),
    assetId: uuid('asset_id').notNull(),
    summary: text('summary').notNull(),
    detail: text('detail'),
    vendor: text('vendor'),
    costMinor: integer('cost_minor'),
    currency: char('currency', { length: 3 }),
    sentOn: date('sent_on').notNull(),
    /** Null while the item is still away — also how `under_repair` is derived. */
    returnedOn: date('returned_on'),
    /**
     * When the overdue sweep last said this one has been away too long.
     *
     * Same job as `assets.warranty_notified_at` and for the same reason: a repair that passed the
     * threshold yesterday has passed it again today, so a sweep with no marker chases the same
     * vendor every morning until the item comes back. Cleared by `repairs.update` when `sent_on`
     * moves, because that is the date the threshold is measured from.
     *
     * Nullable and added in `0004`, so the 0.2.0 image reads the table straight past it.
     */
    overdueNotifiedAt: ts('overdue_notified_at'),
    createdBy: uuid('created_by'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index('inventory_repairs_ws_asset_idx').on(t.workspaceId, t.assetId, t.sentOn),
    /**
     * What the overdue sweep reads: one workspace's still-open repairs, oldest first.
     *
     * The index above starts (workspace_id, asset_id, sent_on) and cannot answer "every open repair
     * in this workspace sent before a date" without visiting every asset; `inventory_repairs_one_
     * open_uq` is partial on the right predicate but keyed by `asset_id`, so it cannot be scoped to
     * a workspace either. Added in `0004`.
     */
    index('inventory_repairs_ws_open_idx').on(t.workspaceId, t.sentOn).where(sql`returned_on is null`),
    /**
     * One open repair per asset, decided by the database rather than by the service.
     *
     * Custody leans on a GiST exclusion constraint for the same reason and this is the cheaper
     * version of it: a repair has no range to overlap, only a flag, so a partial unique index says
     * exactly the same thing. Two people pressing *Send for repair* on the same laptop in the same
     * instant both read "it is here", both insert, and Postgres refuses one of them — where a
     * `select … for update` would serialise them into two open repairs, which is a worse answer
     * wearing the clothes of a safer one. `RepairService` turns the 23505 into a sentence.
     *
     * Not scoped by `workspace_id`: an asset id belongs to exactly one workspace, and adding the
     * column would let the same asset be open in two of them if an id ever leaked across.
     *
     * Added in `0003`, because 0.2.0 is published.
     */
    uniqueIndex('inventory_repairs_one_open_uq').on(t.assetId).where(sql`returned_on is null`),
    /**
     * A repair cannot come back before it was sent.
     *
     * Two dates a person types, and nothing but arithmetic decides whether the pair means anything:
     * stored the wrong way round, every "how long was it away" answer is negative and the overdue
     * sweep measures from a date in the future. `repairs.complete` refused it from the start;
     * `repairs.update` did not, and could move `sent_on` past the `returned_on` of a repair that had
     * already come back. The service checks first so a person gets a sentence, and this is what
     * makes the rule true of the table rather than of the code paths somebody remembered.
     *
     * Added in `0005` as `not valid`: the constraint is enforced on every insert and update from
     * that moment, and existing rows are not scanned. That is deliberate — a module's migrations
     * are the first thing the kernel runs, so a validating constraint that met one bad row left
     * over from this defect would not degrade repairs, it would stop the whole host service
     * booting. `RepairService` translates the resulting 23514 into a sentence.
     */
    check('inventory_repairs_returned_after_sent', sql`returned_on is null or returned_on >= sent_on`),
  ],
)

/** Bytes live in core object storage via `uploadFile`; this only records that an asset has one. */
export const attachments = schema.table(
  'attachments',
  {
    id: id(),
    workspaceId: ws(),
    assetId: uuid('asset_id').notNull(),
    repairId: uuid('repair_id'),
    fileId: uuid('file_id').notNull(),
    name: text('name').notNull(),
    mimeType: text('mime_type'),
    size: integer('size'),
    uploadedBy: uuid('uploaded_by'),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('inventory_attachments_asset_file_uq').on(t.assetId, t.fileId),
    index('inventory_attachments_ws_asset_idx').on(t.workspaceId, t.assetId, t.createdAt),
  ],
)

/** Every tenant table, so the RLS migration can be checked against one list rather than memory. */
export const TENANT_TABLES = [
  // `counters` is a tenant table like any other: it carries `workspace_id`, so one workspace's
  // asset-code sequence is readable to another without a policy. It was left out of this list —
  // and therefore out of `0001_rls.sql` — because it holds no asset data, which is not the rule
  // the file states at the top. Tracker's structurally identical `issue_counters` is covered.
  'counters',
  // Holds nothing but tenant ids, and is still a tenant table: the rule this list encodes is "has a
  // `workspace_id` column", not "holds asset data". `module-tracker`'s equivalent is deliberately
  // unpolicied and that is the one shape of exception this module does not make.
  'workspaces',
  'categories',
  'assets',
  'field_defs',
  'custody_periods',
  'asset_history',
  'repairs',
  'attachments',
] as const
