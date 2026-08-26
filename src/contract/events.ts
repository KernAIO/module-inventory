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
}
