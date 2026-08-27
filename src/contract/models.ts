import { WorkspaceId } from '@kernhq/contracts'
import { z } from 'zod'

/**
 * The nouns this module owns, and the shapes that cross the wire.
 *
 * Imported by **both** halves — the server implements against them, the client calls against them —
 * so nothing here may touch Node. Types only; the procedures live in `router.ts`.
 */

/** Lowercase, 2-32 characters. Names the API prefix, the Postgres schema `mod_<id>` and every event. */
export const MODULE_ID = 'inventory'

/**
 * An asset's lifecycle. `in_stock` and `assigned` follow custody (an open row in `custody_periods`
 * means assigned); `under_repair` follows an open repair; `reserved` follows a booking that has not
 * been collected; `lost` and `retired` are set by hand when an item stops being usable.
 *
 * Stored rather than derived, because every list filter asks for it — and kept in step inside the
 * same transaction that writes the row it derives from, never by a job afterwards.
 *
 * **`under_repair` belongs to the `repairs` capability**, so a workspace with that switch off never
 * has an asset in it: the procedure that ends a repair answers 404 there, and a status nothing can
 * move an item out of is a register the workspace cannot correct. The one thing a job does here is
 * bring the rows *nobody touches* back into step after that switch moves, in both directions —
 * `deriveStatus` in `src/server/services/status.ts` argues it, and nothing is destroyed either way.
 */
export const AssetStatus = z.enum(['in_stock', 'assigned', 'reserved', 'under_repair', 'lost', 'retired'])
export type AssetStatus = z.infer<typeof AssetStatus>

/**
 * A value a workspace defined for itself, stored under its `key` in `assets.custom`.
 *
 * `unknown` rather than a union: the field definition says what the type is, and validating a value
 * against a definition the client may not have loaded yet would fail honest input. The server checks
 * it against `field_defs` before writing.
 */
export const CustomValues = z.record(z.string(), z.unknown())
export type CustomValues = z.infer<typeof CustomValues>

/**
 * A workspace's own grouping of what it owns — Laptops, Furniture, Cameras.
 *
 * Archived rather than deleted, and `archivedAt` is the whole reason: `assets.category_id` is a
 * plain uuid with no foreign key, so a deleted category leaves every asset filed under it pointing
 * at a row that is not there. The list column goes blank and the timeline entry that recorded the
 * move loses the name it recorded. Archiving takes it out of every picker and every filter and
 * leaves each asset able to say what it is.
 */
export const Category = z.object({
  id: z.uuid(),
  workspaceId: WorkspaceId,
  name: z.string().min(1).max(120),
  /**
   * Where it sits in the sequence. **Storage, not a setting.**
   *
   * Nobody thinks about their categories as integers, so no screen shows this number and no input
   * accepts one: `categories.reorder` takes the ids in the order somebody dragged them into and
   * renumbers the live ones `0…n-1` in one transaction. `create` and a restore append, so two live
   * categories never share a value — which is the state a "position" field invited on every save.
   *
   * The name is still the tiebreak in `list`, because a workspace seeded before this existed, or a
   * row written by hand, can still hold a duplicate; it just stops being the ordinary case.
   */
  order: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
})
export type Category = z.infer<typeof Category>

/**
 * What a person types when they add or rename a category: a name, and nothing else.
 *
 * `order` used to be here, optional, and it was the only way to move a category — a number field on
 * a settings form, with a hint explaining that lower comes first and that ties fall back to names.
 * The sequence is written by `categories.reorder` now, so an `order` on create or update would be a
 * second way to set the same thing, disagreeing with the first the moment anybody used it.
 */
export const CategoryInput = z.object({
  name: z.string().trim().min(1).max(120),
})
export type CategoryInput = z.infer<typeof CategoryInput>

/**
 * How many categories one workspace may have live at once — and the reason it is a *stated* limit.
 *
 * `categories.reorder` has to name every live category exactly once, so its input array needs a
 * bound; every zod array that a client fills does, or a single request can ask the server to hold an
 * arbitrary list in memory. A bound on that array alone is a **silent ceiling**: a workspace with
 * more live categories than the number could still create, rename and archive them, and only
 * reordering would fail — the one procedure with no other way to do the job.
 *
 * So the same number is enforced where somebody meets it. `categories.create` and a restore both
 * refuse with `inventory.category.limit_reached` once a workspace holds this many live categories,
 * which is a sentence naming the number at the moment it matters. Archiving one frees a place, which
 * is why the limit counts the **live** rows rather than every row ever made: the advice the refusal
 * gives has to be true.
 */
export const MAX_LIVE_CATEGORIES = 500

/**
 * One stretch of time during which one person held one asset.
 *
 * Effective-dated, exactly as HR keeps employments: nothing is ever updated in place, a change
 * closes the open row and inserts a new one. `effectiveTo === null` means "still holding it", and
 * `inventory_custody_no_overlap` — a GiST exclusion constraint on
 * `(asset_id =, tstzrange(effective_from, effective_to, '[)') &&)` — makes two of those for one
 * asset impossible in the database rather than merely unlikely in the service.
 */
export const CustodyPeriod = z.object({
  id: z.uuid(),
  workspaceId: WorkspaceId,
  assetId: z.uuid(),
  /**
   * The member who held it. A plain uuid — a cross-schema foreign key is what the module boundary
   * exists to prevent — resolved against core membership at read time, which is also why a person
   * who has since left the workspace still has readable history.
   */
  userId: z.uuid(),
  note: z.string().max(500).nullable(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  /** Who did the handing over, which is not always who received it. */
  createdBy: z.uuid().nullable(),
  createdAt: z.string(),
})
export type CustodyPeriod = z.infer<typeof CustodyPeriod>

/**
 * One entry in an asset's timeline.
 *
 * `action` is a **plain string, deliberately not an enum**. The rows are append-only and outlive
 * the image that wrote them: an instance rolled back to a previous release would fail to parse its
 * own history the moment a newer image had written an action the older enum does not list — a
 * timeline that 500s rather than one that says a little less. The client renders a sentence per
 * action it knows and a neutral one for anything else. What is written today is `created`,
 * `updated`, `assigned`, `transferred`, `returned`, `retired`, `restored`, `repair_logged`,
 * `repair_completed`, `attachment_added` and `attachment_removed`.
 */
export const AssetHistoryEntry = z.object({
  id: z.uuid(),
  assetId: z.uuid(),
  /** Null for anything the platform did rather than a person. */
  actorId: z.uuid().nullable(),
  action: z.string().max(40),
  changes: z.array(z.object({ field: z.string(), from: z.unknown(), to: z.unknown() })),
  /** Action-specific ids — who received an item, who handed it over. Never a row. */
  data: z.record(z.string(), z.unknown()),
  occurredAt: z.string(),
})
export type AssetHistoryEntry = z.infer<typeof AssetHistoryEntry>

export const Asset = z.object({
  id: z.uuid(),
  workspaceId: WorkspaceId,
  /** Human-facing asset tag (`INV-0001`), assigned by the server, unique per workspace. */
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(200),
  description: z.string().max(4000),
  categoryId: z.uuid().nullable(),
  status: AssetStatus,
  /**
   * The member currently holding the item. A plain uuid — cross-schema foreign keys are what the
   * module boundary exists to prevent — resolved against core membership at read time.
   */
  custodianUserId: z.uuid().nullable(),
  custodySince: z.string().nullable(),
  serialNumber: z.string().max(200).nullable(),
  location: z.string().max(200).nullable(),
  purchasedOn: z.string().nullable(),
  purchasedFrom: z.string().max(200).nullable(),
  /** Minor units (cents), the convention billing established; formatted on the client. */
  priceMinor: z.number().int().nullable(),
  currency: z.string().length(3).nullable(),
  warrantyUntil: z.string().nullable(),
  photoFileId: z.uuid().nullable(),
  custom: CustomValues,
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
})
export type Asset = z.infer<typeof Asset>

/**
 * What a custody procedure answers with: the asset as it now stands, and the period this call
 * opened.
 *
 * Both, because a screen needs both and fetching the asset again afterwards is a second round trip
 * that can read a row somebody else has changed in between — the panel would then show a handover
 * that has already been undone. `period` is null on a return: something closed, nothing opened.
 */
export const CustodyResult = z.object({
  asset: Asset,
  period: CustodyPeriod.nullable(),
})
export type CustodyResult = z.infer<typeof CustodyResult>

/**
 * One trip an item made to a repairer.
 *
 * `returnedOn === null` means it is still away, and that single fact is what puts the asset in
 * `under_repair` — see `deriveStatus` in `src/server/services/status.ts`, which is the only place
 * the three columns that drive a status are read together.
 *
 * **A repair is not custody, and neither one cancels the other.** A laptop assigned to Dan that goes
 * to the repairer is still Dan's responsibility: the custody period stays open, `custodianUserId`
 * stays set, and only `status` moves. That is why a repair does not touch custody and custody does
 * not refuse a repaired item — the two answer different questions ("who is answerable for it" and
 * "where is it"), and collapsing them would mean an item could not come back to the person who sent
 * it.
 */
export const Repair = z.object({
  id: z.uuid(),
  workspaceId: WorkspaceId,
  assetId: z.uuid(),
  summary: z.string().min(1).max(200),
  detail: z.string().max(4000).nullable(),
  vendor: z.string().max(200).nullable(),
  /** Minor units, like `Asset.priceMinor` — one convention for money across the module. */
  costMinor: z.number().int().nullable(),
  currency: z.string().length(3).nullable(),
  sentOn: z.string(),
  /** Null while it is still away. Set by `repairs.complete` and by nothing else. */
  returnedOn: z.string().nullable(),
  createdBy: z.uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Repair = z.infer<typeof Repair>

/**
 * A repair in a list, with the two things a reader needs to know *which item* it is about.
 *
 * **Joined at read time, never stored here.** `mod_inventory.repairs` holds no asset name, so
 * renaming an asset renames it everywhere at once — a copied label is a label that goes stale, and
 * this module already refuses to copy a person's name for the same reason. The join is inside one
 * schema, which is the kind a module is allowed to make; the kind it is not is a join across the
 * boundary into another module's tables.
 *
 * It extends `Repair` rather than replacing it, so a component that renders a repair renders one of
 * these without knowing the difference. `create`, `update` and `complete` answer with a plain
 * `Repair`: the caller of those already knows which asset it asked about.
 */
export const RepairListItem = Repair.extend({
  assetCode: z.string().min(1).max(40),
  assetName: z.string().min(1).max(200),
})
export type RepairListItem = z.infer<typeof RepairListItem>

/**
 * Everything a person can say about a repair.
 *
 * **No field here carries `.default()`, for the reason `AssetInput` spells out**: `update` is built
 * from `.partial()`, and `.partial()` does not strip a default — zod still substitutes it for a key
 * the request never sent, so a patch that renames a repair would silently re-date it. `sentOn` is
 * optional rather than defaulted for the same reason; `repairs.create` fills today's date on the
 * server, which is the only clock this module trusts.
 */
export const RepairInput = z.object({
  summary: z.string().trim().min(1).max(200),
  detail: z.string().max(4000).nullish(),
  vendor: z.string().max(200).nullish(),
  costMinor: z.number().int().min(0).nullish(),
  currency: z.string().length(3).nullish(),
  /** `sent_on` is `not null` in the database, so this is optional but never nullable. */
  sentOn: z.iso.date().optional(),
})
export type RepairInput = z.infer<typeof RepairInput>

export const RepairPatchInput = RepairInput.partial()
export type RepairPatchInput = z.infer<typeof RepairPatchInput>

/**
 * What a repair mutation answers with: the repair, and the asset as it now stands.
 *
 * Both, for the reason `CustodyResult` carries both — sending an item away moves `assets.status`,
 * and a screen that had to fetch the asset again afterwards would be reading a row somebody else
 * may have changed in between.
 */
export const RepairResult = z.object({
  repair: Repair,
  asset: Asset,
})
export type RepairResult = z.infer<typeof RepairResult>

/**
 * A file recorded against an asset — a receipt, a warranty card, a manual.
 *
 * **The bytes are core's, not this module's.** A module does not upload: the browser uploads through
 * core's file service and hands this module the id it was given, and reading one back is a download
 * URL core signs. All that lives here is the fact that this asset has that file, plus the name and
 * size copied at attach time so a list can be drawn without asking core once per row.
 *
 * `repairId` is what separates "the invoice for the screen replacement" from "the purchase receipt":
 * null means it belongs to the asset itself.
 */
export const Attachment = z.object({
  id: z.uuid(),
  workspaceId: WorkspaceId,
  assetId: z.uuid(),
  repairId: z.uuid().nullable(),
  fileId: z.uuid(),
  name: z.string().max(300),
  mimeType: z.string().max(200).nullable(),
  /** Bytes, as core reported them when the file was attached. */
  size: z.number().int().nullable(),
  uploadedBy: z.uuid().nullable(),
  createdAt: z.string(),
})
export type Attachment = z.infer<typeof Attachment>

/**
 * The register in numbers: what a page's count line and a dashboard card need in one request.
 *
 * `total` counts what the list shows by default — live rows — and `archived` is beside it rather
 * than inside it, because a count line that silently included archived rows would disagree with the
 * list under it.
 *
 * **`outForRepair` is null when the workspace does not track repairs.** Zero would be a claim
 * ("nothing is away"), and a workspace with the `repairs` capability off has not made that claim —
 * it has no opinion at all. The screens show the tile only when a number arrives, which is the same
 * rule as hiding the Repairs tab, expressed in the data instead of in a second capability lookup.
 */
export const InventoryStats = z.object({
  total: z.number().int().nonnegative(),
  archived: z.number().int().nonnegative(),
  /** Every status, zero-filled, so a screen can render the set without knowing which exist. */
  byStatus: z.record(AssetStatus, z.number().int().nonnegative()),
  outForRepair: z.number().int().nonnegative().nullable(),
  /** Live assets nobody is holding — what is actually available to hand out. */
  unassigned: z.number().int().nonnegative(),
})
export type InventoryStats = z.infer<typeof InventoryStats>

/**
 * How a list is ordered, and therefore what a page cursor is a bookmark *into*.
 *
 * Exported rather than written inline in `router.ts` because the server validates a cursor against
 * this same list: a bookmark issued under one sort is meaningless under another, and the only way
 * to say so is for both halves to read one enum.
 */
export const AssetSort = z.enum(['recent', 'name', 'code'])
export type AssetSort = z.infer<typeof AssetSort>

/**
 * Everything a person can say about an asset. `create` requires `name`; `update` takes any subset.
 *
 * **No field here carries `.default()`, and that is load-bearing.** `update` is built from
 * `AssetInput.partial()`, and `.partial()` does not strip a default — it only wraps the field in
 * `optional`, so zod still substitutes the default for a key the request never sent. `description`
 * had `.default('')`, so `PATCH {assetId, name}` reached the handler as
 * `{assetId, name, description: ''}`; the service correctly read a present value as "set it" and a
 * rename destroyed the text, writing a bogus `description` diff into `asset_history` as it went.
 * The care the service takes over `undefined` versus `null` is defeated one layer above it, here.
 * A value `create` should fill in belongs on `AssetCreateInput` below, which is never partialled.
 */
export const AssetInput = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  categoryId: z.uuid().nullish(),
  serialNumber: z.string().max(200).nullish(),
  location: z.string().max(200).nullish(),
  purchasedFrom: z.string().max(200).nullish(),
  purchasedOn: z.iso.date().nullish(),
  warrantyUntil: z.iso.date().nullish(),
  priceMinor: z.number().int().min(0).nullish(),
  currency: z.string().length(3).nullish(),
  photoFileId: z.uuid().nullish(),
  // `custom` is deliberately absent: there is nothing to validate a value against until
  // `fields.*` exists, and accepting arbitrary JSON into a column a workspace has not defined
  // is how a schemaless field bag becomes permanent. It arrives with the field definitions.
})
export type AssetInput = z.infer<typeof AssetInput>

/**
 * What `create` accepts: the same fields, with the one value a new row may not go without.
 *
 * `description` is `not null` in the database, so a create with no description needs *something*.
 * Defaulting it here rather than in `AssetInput` is what keeps `update` able to tell "leave it
 * alone" from "clear it" — see the note above.
 */
export const AssetCreateInput = AssetInput.extend({
  description: z.string().max(4000).default(''),
})
export type AssetCreateInput = z.infer<typeof AssetCreateInput>

/** What `update` accepts: any subset, and nothing filled in for a key that never arrived. */
export const AssetPatchInput = AssetInput.partial()
export type AssetPatchInput = z.infer<typeof AssetPatchInput>

/** Shared by every workspace-scoped procedure, which is all of them. */
export const ws = z.object({ workspaceId: WorkspaceId })
