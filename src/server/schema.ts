import { moduleSchema } from '@kernhq/kernel'
import { sql } from 'drizzle-orm'
import {
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
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
 * Asset lifecycle. Stored rather than derived because every list filter asks for it; every
 * transition is written inside the same transaction as the row it derives from.
 */
export const assetStatus = pgEnum('asset_status', ['in_stock', 'assigned', 'under_repair', 'retired'])

export const counters = schema.table(
  'counters',
  /** Per-workspace sequence sources (`asset_code`). Narrow on purpose: one row per key. */
  {
    workspaceId: ws().primaryKey(),
    key: text('key').primaryKey(),
    value: integer('value').notNull(),
  },
)

export const categories = schema.table(
  'categories',
  {
    id: id(),
    workspaceId: ws(),
    name: text('name').notNull(),
    order: integer('order').notNull().default(0),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex('inventory_categories_ws_name_uq').on(t.workspaceId, t.name),
    index('inventory_categories_ws_idx').on(t.workspaceId, t.order),
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
    status: assetStatus('status').notNull().default('in_stock'),
    /** Denormalized from `custody_periods`, which stays authoritative for history. */
    custodianUserId: uuid('custodian_user_id'),
    custodySince: ts('custody_since'),
    serialNumber: text('serial_number'),
    location: text('location'),
    purchasedOn: date('purchased_on'),
    purchasedFrom: text('purchased_from'),
    priceMinor: integer('price_minor'),
    currency: char('currency', { length: 3 }),
    warrantyUntil: date('warranty_until'),
    photoFileId: uuid('photo_file_id'),
    createdAt: created(),
    updatedAt: updated(),
    archivedAt: ts('archived_at'),
  },
  (t) => [
    uniqueIndex('inventory_assets_ws_code_uq').on(t.workspaceId, t.code),
    index('inventory_assets_ws_created_idx').on(t.workspaceId, t.createdAt),
    index('inventory_assets_ws_status_idx').on(t.workspaceId, t.status),
    index('inventory_assets_ws_category_idx').on(t.workspaceId, t.categoryId),
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
    type: text('type').notNull(), // text | number | date | select | multiselect | checkbox | url
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
    action: text('action').notNull(), // created | updated | transferred | returned | repair_logged | repair_completed | attachment_added | retired | restored
    changes: jsonb('changes').$type<{ field: string; from: unknown; to: unknown }[]>(),
    data: jsonb('data'),
    occurredAt: created(),
  },
  (t) => [index('inventory_asset_history_asset_idx').on(t.workspaceId, t.assetId, t.occurredAt)],
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
    createdBy: uuid('created_by'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index('inventory_repairs_ws_asset_idx').on(t.workspaceId, t.assetId, t.sentOn)],
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
  'categories',
  'assets',
  'field_defs',
  'custody_periods',
  'asset_history',
  'repairs',
  'attachments',
] as const
