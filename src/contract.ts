import { baseContract, defineEvent, definePermissions, PageInput, page, WorkspaceId } from '@kernhq/contracts'
import { z } from 'zod'

/**
 * What this module offers, as data.
 *
 * Imported by **both** halves — the server implements it, the client calls it — so nothing here may
 * touch Node. The contract is the only thing that crosses that line, which is why a procedure that
 * exists here and not in the router is a lie that compiles. `module.test.ts` checks exactly that.
 */

/** Lowercase, 2-32 characters. Names the API prefix, the Postgres schema `mod_<id>` and every event. */
export const MODULE_ID = 'inventory'

/**
 * An asset's lifecycle. `in_stock` and `assigned` follow custody (an open row in
 * `custody_periods` means assigned); `under_repair` follows an open repair; `retired` is set by
 * hand when an item leaves the company. Stored, because every list filter needs it, and kept in
 * step inside the same transaction that writes the row it derives from.
 */
export const AssetStatus = z.enum(['in_stock', 'assigned', 'under_repair', 'retired'])
export type AssetStatus = z.infer<typeof AssetStatus>

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
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
})
export type Asset = z.infer<typeof Asset>

const ws = z.object({ workspaceId: WorkspaceId })

const AssetCreateInput = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
  categoryId: z.uuid().nullish(),
  serialNumber: z.string().max(200).nullish(),
  location: z.string().max(200).nullish(),
  purchasedFrom: z.string().max(200).nullish(),
  purchasedOn: z.iso.date().nullish(),
  warrantyUntil: z.iso.date().nullish(),
  priceMinor: z.number().int().min(0).nullish(),
  currency: z.string().length(3).nullish(),
})

export const inventoryContract = {
  assets: {
    list: baseContract
      .route({ method: 'GET', path: '/assets', tags: ['inventory'] })
      .input(
        ws.extend({
          ...PageInput.shape,
          q: z.string().max(200).optional(),
          categoryId: z.uuid().optional(),
          status: AssetStatus.optional(),
          sort: z.enum(['recent', 'name', 'code']).default('recent'),
        }),
      )
      .output(page(Asset)),
    get: baseContract
      .route({ method: 'GET', path: '/assets/{assetId}', tags: ['inventory'] })
      .input(ws.extend({ assetId: z.uuid() }))
      .output(Asset),
    create: baseContract
      .route({ method: 'POST', path: '/assets', tags: ['inventory'] })
      .input(ws.extend(AssetCreateInput.shape))
      .output(Asset),
    update: baseContract
      .route({ method: 'PATCH', path: '/assets/{assetId}', tags: ['inventory'] })
      .input(
        ws.extend({
          assetId: z.uuid(),
          ...AssetCreateInput.partial().shape,
        }),
      )
      .output(Asset),
    archive: baseContract
      .route({ method: 'POST', path: '/assets/{assetId}/archive', tags: ['inventory'] })
      .input(ws.extend({ assetId: z.uuid(), archived: z.boolean().default(true) }))
      .output(Asset),
  },
}
export type InventoryContract = typeof inventoryContract

/** `<module>.<entity>.<action>`. Anything that emits one declares it here. Payloads carry ids, never rows. */
export const inventoryEvents = {
  assetCreated: defineEvent(
    'inventory.asset.created',
    z.object({ assetId: z.uuid(), workspaceId: WorkspaceId }),
  ),
  assetUpdated: defineEvent(
    'inventory.asset.updated',
    z.object({ assetId: z.uuid(), workspaceId: WorkspaceId }),
  ),
  assetArchived: defineEvent(
    'inventory.asset.archived',
    z.object({ assetId: z.uuid(), workspaceId: WorkspaceId }),
  ),
}

/**
 * `<module>.<resource>.<action>`, each with the narrowest scope that works and the roles that hold it
 * by default. A workspace can add or remove any of them afterwards with a custom role.
 */
export const inventoryPermissions = definePermissions([
  {
    key: 'inventory.asset.view',
    label: 'View assets',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin', 'member', 'guest'],
    dangerous: false,
  },
  {
    key: 'inventory.asset.manage',
    label: 'Create and edit assets',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },
])
