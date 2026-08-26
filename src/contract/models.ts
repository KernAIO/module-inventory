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
