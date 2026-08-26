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
  // `warrantyNoticeDays` used to sit here, describing a warranty sweep that has never existed —
  // no job, no subscription, nothing reading the number. A setting nothing enforces is the same
  // lie as a capability nothing checks: it teaches an administrator that the settings page does
  // not mean anything. It comes back with the sweep.
})
export type InventorySettings = z.infer<typeof InventorySettings>
