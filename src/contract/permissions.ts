import { definePermissions } from '@kernhq/contracts'

/**
 * `<module>.<resource>.<action>`, each with the narrowest scope that works and the roles that hold
 * it by default. A workspace can add or remove any of them afterwards with a custom role.
 *
 * A key with nothing checking it is a role editor full of switches that do nothing, so these arrive
 * with the procedures that enforce them — `custody.manage`, `repair.manage`, `category.manage`,
 * `field.manage`, `value.view` and the stock and purchasing keys with their own phases.
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
