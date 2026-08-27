import { z } from 'zod'

/**
 * Workspace-level settings for Inventory.
 *
 * Deliberately small. Nearly everything an administrator configures belongs to a category, a
 * location or a field definition, because those are the things that differ between two kinds of
 * item in the same company. What is left is genuinely workspace-wide.
 *
 * Note what is *not* here: the capability switches. Those live under a reserved `$capabilities` key
 * the platform owns, so turning one off cannot collide with a settings field and cannot be dropped
 * by a settings round-trip.
 */
export const InventorySettings = z.object({
  /**
   * What an asset tag looks like. `INV-` and 4 gives `INV-0042`.
   *
   * People read these off a sticker and say them out loud, so a workspace that already labels its
   * laptops `LT-` should not have to keep two numbering systems in its head. The counter itself is a
   * row in `mod_inventory.counters`, not a setting — a number an administrator can edit is a number
   * that produces a duplicate tag.
   */
  assetCodePrefix: z.string().max(8).default('INV-'),
  assetCodePad: z.number().int().min(1).max(10).default(4),
  /**
   * How far ahead of a warranty running out somebody is told.
   *
   * This spent a release describing a sweep that did not exist — no job, no subscription, nothing
   * reading the number — and was taken out for it. It is back because `warranty-sweep` reads it
   * every morning: a live asset whose `warranty_until` falls inside this many days earns exactly
   * one notice, marked on the row so the next morning does not send it again.
   *
   * A month by default, which is about how long it takes to decide whether to extend a warranty or
   * budget for a replacement. Capped at a year: further out than that is not a notice, it is a
   * report.
   */
  warrantyNoticeDays: z.number().int().min(1).max(365).default(30),
  /**
   * How long an item may be at a repairer before somebody is asked to chase it.
   *
   * Read by `repair-overdue`, which tells the person who logged the repair — and whoever is still
   * holding the item — once, and then leaves them alone. Two weeks by default: long enough that an
   * ordinary screen replacement never trips it, short enough that a laptop nobody chased does.
   *
   * A workspace with the `repairs` capability off never meets this: the sweep asks first, and a
   * setting whose feature is switched off changes nothing rather than firing quietly.
   */
  repairOverdueDays: z.number().int().min(1).max(365).default(14),
})
export type InventorySettings = z.infer<typeof InventorySettings>
