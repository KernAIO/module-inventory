import { session } from '@kernhq/ui'
import { inventoryPermissions, MODULE_ID } from '../contract.js'

/**
 * What this module lets somebody do.
 *
 * **Derived from the contract, never re-typed.** `key()` throws at import if a name is not declared,
 * which is the whole point: a hand-copied permission string type-checks perfectly while being wrong,
 * and a wrong one silently hides a control or offers one the server refuses.
 *
 * Hide what a person may never do; disable — with a reason — what they cannot do right now. The
 * server checks again on every call regardless; this only stops the interface offering a door that
 * will not open.
 */
const key = (suffix: string) => {
  const found = inventoryPermissions.find((p) => p.key === `${MODULE_ID}.${suffix}`)
  if (!found) throw new Error(`${MODULE_ID}: no permission declared for ${MODULE_ID}.${suffix}`)
  return found.key
}

export const INVENTORY_PERMISSIONS = {
  view: key('asset.view'),
  manage: key('asset.manage'),
} as const

export type InventoryPermission = keyof typeof INVENTORY_PERMISSIONS

export function canInventory(permission: InventoryPermission): boolean {
  return session.can(INVENTORY_PERMISSIONS[permission])
}
