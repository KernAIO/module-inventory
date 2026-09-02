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
 * The rest arrive with the work that makes them mean something: `labels` and `locations` with the
 * register; `stock` and `procurement` with stock control; `depreciation` and `reservations` last.
 * Adding one here before its procedures exist is the mistake this comment is here to prevent.
 *
 * **Custom fields are deliberately not one.** A workspace that defines no field sees nothing — no
 * section on the form, no rows on the panel — so the feature switches itself off by being empty,
 * and a switch beside that would be one that changes nothing.
 */
export const inventoryCapabilities = defineCapabilities([
  {
    id: 'core',
    label: 'Assets',
    // Says only what the module answers today, which is the rule this line has been held to in both
    // directions: custody and the change history were taken *out* of it while neither had a
    // procedure, and put back in the change that gave them one.
    description:
      'The asset register: what the company owns item by item, who is holding each one, and how each one got there',
    required: true,
    level: 1,
  },
  {
    /**
     * The first capability anyone can actually switch, and the reason it is one is the shape of the
     * customers: an office that hands out laptops wants a register and never records a repair,
     * while a company with a workshop wants little else. One answer for the whole workspace, not
     * per person — so a capability rather than a permission — and switching it off writes a boolean
     * into module settings and leaves every repair row exactly where it was.
     *
     * `dependsOn: ['core']` says the obvious out loud: a repair is a trip *an asset* made, so there
     * is nothing to record without the register. It also means the closure prunes this
     * automatically if `core` could ever be off, rather than each screen remembering to check two
     * switches.
     */
    id: 'repairs',
    label: 'Repairs',
    description:
      'What went away to be fixed, to whom, what it cost and when it came back — and the `under repair` status that follows an open one',
    dependsOn: ['core'],
    defaultEnabled: true,
    level: 1,
  },
  {
    /**
     * Files against an asset or a repair — a purchase receipt, a warranty card, a repair invoice.
     *
     * Separate from `repairs` because plenty of workspaces want one without the other: an office
     * that keeps receipts and never records a repair, and a workshop that records repairs and keeps
     * no paperwork. Switching it off hides the Files tab and answers 404; the rows and the files in
     * core's storage are untouched, which is what makes it a capability rather than a migration.
     */
    id: 'attachments',
    label: 'Files',
    description: 'Receipts, warranties and manuals kept against an asset or one of its repairs',
    dependsOn: ['core'],
    defaultEnabled: true,
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
export const inventoryCapabilityProcedures: Record<string, readonly string[]> = {
  repairs: ['repairs.list', 'repairs.create', 'repairs.update', 'repairs.complete'],
  attachments: ['attachments.list', 'attachments.add', 'attachments.remove'],
  // `stats.summary` is deliberately absent. It counts assets, which is `core`, and it answers
  // `outForRepair: null` rather than a number when the workspace has `repairs` off — a count line
  // and a dashboard card must not disappear because a *different* feature is switched off.
}
