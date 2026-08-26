/**
 * The client half.
 *
 * Published as **source**, not compiled: the consumer builds the TypeScript and Svelte with its own
 * toolchain, which is what lets `$state` in a module store stay reactive inside the app.
 *
 * Everything the interface offers lives here — the manifest, the screens, this module's own strings
 * and its permissions. The app registers `inventoryClientModule` and mounts whatever it declares; it
 * holds no screens of its own. Deleting this package removes the feature completely.
 *
 * **Import the file, not this barrel, from inside the package.** This re-exports `module.js`, which
 * reaches Svelte components and the framework's rune-backed singletons — so a pure-function test
 * that goes through here fails with "$state is not defined", and a file that imports its own barrel
 * is a cycle that resolves inside the app and breaks the moment the package is built alone. Both
 * happened, in three modules, before this note existed.
 *
 * `files` in package.json must cover every directory this entry reaches, contract source included.
 */

export { type Asset, type AssetStatus, inventoryPermissions, MODULE_ID } from '../contract.js'
export { createInventoryClient, type InventoryApi } from './api.js'
export { __setInventoryApi, getInventoryApi } from './api-instance.js'
export { type InventoryMessageKey, inventoryMessageBundles, t } from './i18n.js'
export { inventoryClientModule, inventoryClientModule as default } from './module.js'
export { canInventory, INVENTORY_PERMISSIONS, type InventoryPermission } from './permissions.js'
export { inventoryKeys } from './query.js'
