import type { core } from '@kernhq/contracts'

/**
 * What Inventory will interrupt somebody about.
 *
 * Four things, and each of them changes what somebody has to *do*. That is the test: a rename, a new
 * category, an item coming back — those are facts a screen shows when somebody looks, and a
 * notification type nobody wants is a notification type everybody switches off along with the one
 * that mattered.
 *
 * A type declared here and never sent is the same lie as a permission nothing checks. Each of these
 * names its sender, and every one of them exists:
 *
 * - `custody.assigned` — `CustodyService`, on `assign` and `transfer`.
 * - `warranty.expiring` — the `warranty-sweep` job, once per asset.
 * - `repair.overdue` — the `repair-overdue` job, once per repair.
 * - `custody.return_due` — the offboarding subscription, when HR says somebody has left or core says
 *   they have been removed from the workspace.
 *
 * The keys keep their `inventory.custody.*` spelling rather than being renamed to
 * `inventory.asset.*`: a notification type is the key a person's own preferences are stored under,
 * so renaming one silently resets everybody who had switched it off.
 */
export const inventoryNotificationTypes: core.NotificationTypeDef[] = [
  {
    /**
     * Everybody who has ever found a laptop on their desk with no idea it was now theirs is the
     * reason this is `urgent` and reaches email — an asset register that records a handover the
     * recipient never learns about has recorded an argument for later.
     */
    type: 'inventory.custody.assigned',
    label: 'An item was handed to you',
    description: 'Somebody made you the holder of an asset in the register.',
    defaults: { inapp: true, push: true, email: true },
    urgent: true,
  },
  {
    /**
     * Not urgent, and email is off by default. A warranty running out in a month is a thing to plan
     * for, not a thing to stop for — and it arrives on a schedule rather than because somebody did
     * something, which is exactly the kind of message that trains people to ignore the rest.
     */
    type: 'inventory.warranty.expiring',
    label: 'A warranty is about to run out',
    description: "An item's warranty expires soon. Sent once per item, to whoever is holding it.",
    defaults: { inapp: true, push: false, email: false },
    urgent: false,
  },
  {
    /**
     * Push, because this one is an action somebody has to take — ring the repairer — and nobody
     * goes looking for it. Still not urgent: a laptop that has been away a fortnight can wait until
     * the phone is picked up.
     */
    type: 'inventory.repair.overdue',
    label: 'A repair has been away too long',
    description: 'An item sent for repair has not been logged as returned. Sent once per repair.',
    defaults: { inapp: true, push: true, email: false },
    urgent: false,
  },
  {
    /**
     * Somebody is leaving and still has company property. Email, because it is a list of things to
     * collect from a person who may not be at their desk much longer, and an in-app badge nobody
     * opens until Monday is how a laptop leaves the building.
     */
    type: 'inventory.custody.return_due',
    label: 'Somebody leaving still holds company property',
    description: 'A member has left, or is leaving, and items are still recorded as theirs.',
    defaults: { inapp: true, push: true, email: true },
    urgent: true,
  },
]
