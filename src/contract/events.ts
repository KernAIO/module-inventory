import { defineEvent, WorkspaceId } from '@kernhq/contracts'
import { z } from 'zod'

/**
 * `<module>.<entity>.<action>`. Anything that emits one declares it here.
 *
 * Payloads carry **ids, never rows**. A subscriber that needs the record asks for it with its own
 * principal, so an event cannot become a way to read data past a permission check.
 */
export const inventoryEvents = {
  assetCreated: defineEvent(
    'inventory.asset.created',
    z.object({ assetId: z.uuid(), workspaceId: WorkspaceId }),
  ),
  assetUpdated: defineEvent(
    'inventory.asset.updated',
    z.object({ assetId: z.uuid(), workspaceId: WorkspaceId }),
  ),
  assetArchived: defineEvent(
    'inventory.asset.archived',
    z.object({ assetId: z.uuid(), workspaceId: WorkspaceId }),
  ),
  /**
   * The other half of `archive`, which is also the restore path (`archived: false`).
   *
   * One procedure emitting `archived` whichever way the flag pointed told every subscriber that a
   * restored item had just been retired — and the module's own `asset_history` row already knew
   * better, recording `retired` and `restored` separately.
   */
  assetRestored: defineEvent(
    'inventory.asset.restored',
    z.object({ assetId: z.uuid(), workspaceId: WorkspaceId }),
  ),
  /**
   * One event for all three of assign, transfer and return, because a subscriber cares that the
   * answer to "who has it" moved and not by which verb.
   *
   * `userId` is null when it came back to stock and `previousUserId` is null when it went out from
   * stock, so the pair says which of the three happened without a fourth field claiming to. Both
   * are ids, like everything else here: a subscriber that needs the person asks core with its own
   * principal, so an event cannot become a way to read a name past a permission check.
   *
   * Nothing subscribes to it inside this module. It exists for what is outside — an offboarding
   * automation that asks what somebody still holds, most obviously — which is the whole reason a
   * module emits events rather than only writing its own history row.
   */
  custodyChanged: defineEvent(
    'inventory.custody.changed',
    z.object({
      assetId: z.uuid(),
      workspaceId: WorkspaceId,
      userId: z.uuid().nullable(),
      previousUserId: z.uuid().nullable(),
    }),
  ),
  /**
   * An item went to a repairer, and an item came back.
   *
   * Two events rather than one, where custody has one for three verbs — because a subscriber to
   * custody cares only that "who has it" moved, while these two are opposite facts with opposite
   * reactions: something outside this module wants to tell the holder their laptop has gone, and
   * something else wants to tell them it is back. A single `repair.changed` would make every
   * subscriber re-read the row to find out which happened.
   *
   * No `repair.updated`: correcting a vendor or filling in an invoice a week later is not a fact
   * anything outside this module reacts to, and the screens that do care are refreshed by
   * `kernel.realtime.change`, which needs no declaration. Declaring one so the set looks symmetrical
   * is the same lie as a capability nothing checks.
   */
  repairOpened: defineEvent(
    'inventory.repair.opened',
    z.object({ assetId: z.uuid(), repairId: z.uuid(), workspaceId: WorkspaceId }),
  ),
  repairCompleted: defineEvent(
    'inventory.repair.completed',
    z.object({ assetId: z.uuid(), repairId: z.uuid(), workspaceId: WorkspaceId }),
  ),
  // No category and no attachment events, deliberately. An event is for something outside this
  // module to react to, and nothing outside it has an opinion about a workspace renaming "Laptops"
  // or filing a receipt; the screens that do care are refreshed by `kernel.realtime.change`, which
  // needs no declaration. Declaring one here so the list looks complete is the same lie as a
  // capability nothing checks.
}
