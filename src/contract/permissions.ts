import { definePermissions } from '@kernhq/contracts'

/**
 * `<module>.<resource>.<action>`, each with the narrowest scope that works and the roles that hold
 * it by default. A workspace can add or remove any of them afterwards with a custom role.
 *
 * A key with nothing checking it is a role editor full of switches that do nothing, so these arrive
 * with the procedures that enforce them — the stock and purchasing keys with their own phases.
 *
 * **Reading custody is `asset.view`, and that is a decision rather than an omission.** Who holds an
 * item looks like a privacy question, and it is not one here: `custodianUserId` and `custodySince`
 * are fields of `Asset`, returned by `assets.list` and `assets.get` under `asset.view` since the
 * module existed, and `assets.list` has always taken a `custodianUserId` filter. A separate
 * `custody.view` would be a lock on a door beside an open window — it would refuse the timeline
 * while the row above it named the same person. "Who has the projector" is also the question an
 * asset register exists to answer; a company where a member cannot find that out asks in chat
 * instead, which is worse for whoever is holding it. A workspace that disagrees takes
 * `inventory.asset.view` off `guest`, which is one switch and already there. Writing custody is
 * `custody.manage`, because handing an item over makes somebody answerable for it.
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
  {
    /**
     * Not `asset.manage`: correcting a serial number and making a colleague answerable for a
     * £2,000 laptop are different acts, and plenty of workspaces want the first from everybody and
     * the second from the office manager. Held by `member` by default all the same — an office
     * where only an admin may hand over a charger keeps its register by not using it.
     */
    key: 'inventory.custody.manage',
    label: 'Hand assets over and take them back',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },
  {
    /**
     * Sending an item away and recording what it cost, held by `member` for the same reason
     * `custody.manage` is: the person who notices a broken screen is the person who should be able
     * to log it, and an office where only an admin may do that keeps its repair record by not
     * keeping one. Reading repairs rides `asset.view` — "where is the projector" is the question
     * the register exists to answer, and a repair is one of the two answers.
     *
     * Not folded into `asset.manage`: correcting a serial number and committing the company to a
     * £400 screen replacement are different acts, and the money is why.
     */
    key: 'inventory.repair.manage',
    label: 'Log repairs',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },
  {
    /**
     * Categories are workspace configuration — one list everybody's assets are filed against — so
     * this sits with the people who set the workspace up rather than with everybody who may edit an
     * asset. Reading them rides `asset.view`, because the picker on the asset form needs them.
     */
    key: 'inventory.category.manage',
    label: 'Manage asset categories',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },
  {
    /**
     * Field definitions are workspace configuration in the same sense categories are — one set of
     * questions every asset form asks — so the same people hold it. Reading them rides `asset.view`
     * because the form and the panel need them to render a value; writing a *value* is
     * `asset.manage`, because a value is part of the asset.
     */
    key: 'inventory.field.manage',
    label: 'Define custom fields',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },
])
