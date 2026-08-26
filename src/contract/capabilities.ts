import { defineCapabilities } from '@kernhq/contracts'

/**
 * How much Inventory this workspace has.
 *
 * The module answers two questions that look like one: *what do we own and who has it* (an office
 * with forty laptops) and *how much of this do we have and where* (a warehouse with bins and
 * reorder points). Both are "things the company has", both want the same categories, locations,
 * suppliers, attachments and search — and almost nobody wants both halves at once. Capabilities are
 * what keep the small case small: an office switches on nothing beyond the register and never meets
 * the word "bin".
 *
 * **Declared here only once something is behind it.** A switch that changes nothing teaches an
 * administrator that the switchboard does not mean anything, so this list grows with the module.
 *
 * Two rules decide whether something belongs here at all:
 *
 * - **Not a permission.** "May Ada write off a laptop" is a permission — true for her, false for
 *   somebody else, in the same workspace. "Does this company track stock levels" is a capability:
 *   one answer for everyone, the owner included, and the answer is 404 rather than 403.
 * - **Reversible without a migration.** Switching one off writes a boolean into module settings and
 *   the rows stay exactly where they are. Anything that would need data thrown away to reverse is
 *   not a capability, however much it looks like one.
 *
 * The rest arrive with the work that makes them mean something: `repairs`, `attachments` and
 * `labels` with the finished register; `custom_fields` and `locations` beside them; `stock` and
 * `procurement` with stock control; `depreciation` and `reservations` last. Adding one here before
 * its procedures exist is the mistake this comment is here to prevent.
 */
export const inventoryCapabilities = defineCapabilities([
  {
    id: 'core',
    label: 'Assets',
    // Says only what the module answers today. Custody and the change history are what the schema
    // is shaped for and neither has a procedure yet, so naming them here promised a workspace two
    // features it would then go looking for.
    description: 'The asset register: what the company owns, item by item',
    required: true,
    level: 1,
  },
])

export type InventoryCapabilityId = (typeof inventoryCapabilities)[number]['id']

/**
 * Which procedures sit behind which capability.
 *
 * Declared as data because a missing `requiresCapability` is invisible: the procedure compiles,
 * every other test passes, and the only symptom is a workspace calling a feature it switched off.
 * `module.test.ts` reads this and fails when a procedure named here is not carrying the middleware.
 *
 * A procedure absent from this map belongs to the module as a whole and is reachable whenever
 * Inventory is on — which for `core` is always, because it is `required`.
 */
export const inventoryCapabilityProcedures: Record<string, readonly string[]> = {}
