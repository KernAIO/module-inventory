import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  InventorySettings,
  inventoryCapabilities,
  inventoryContract,
  inventoryEvents,
  inventoryPermissions,
  MODULE_ID,
} from '../contract/index.js'
import { defineModule, defineServerModule, inventoryRouter, packageVersion } from './router.js'
import { schema } from './schema.js'

export const inventoryModule = defineServerModule({
  definition: defineModule({
    id: MODULE_ID,
    name: 'Inventory',
    version: packageVersion(import.meta.url),
    description:
      'The asset register: what the company owns, item by item — tags, serial numbers, purchase and warranty details',
    icon: 'briefcase',
    permissions: inventoryPermissions,
    capabilities: inventoryCapabilities,
    events: inventoryEvents,
    settings: InventorySettings,
    // `objectTypes` returns with the resolver that turns a mention or a link into an asset and the
    // indexer that puts one in search — declaring the type with neither made both resolve to
    // nothing, which reads to a user as a broken link rather than as a feature not built yet.
  }),
  /** Attached so the developer panel can check the router against what was promised. */
  contract: inventoryContract,
  schema,
  migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '../../migrations'),
  router: inventoryRouter,
})
export default inventoryModule
