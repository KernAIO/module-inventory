import type { Kernel } from '@kernhq/kernel'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { MODULE_ID } from '../../contract/models.js'
import { assets } from '../schema.js'
import { membersWithPermission } from './audience.js'
import type { NotifyService } from './notify.js'
import { assetUrl } from './search.js'

/** How many tags fit in one sentence before it stops being readable. */
const TAGS_IN_BODY = 5

/**
 * More than anybody is plausibly holding, and a bound all the same: this reads every live asset of
 * one person, and an unbounded query in an event handler is an unbounded query.
 */
const MAX_HELD = 200

/** Why the checklist is being raised, which is the only difference between the two callers. */
export type Departure =
  /** `core.member.removed` — the account is out of the workspace already. */
  | 'removed'
  /** `hr.person.status_changed` to a status that ends employment — they may still be at their desk. */
  | 'leaving'

export interface ReturnList {
  items: Array<{ id: string; code: string; name: string }>
  /** Who was told. Empty when there was nothing to return, or nobody who could act on it. */
  recipients: string[]
}

/**
 * Somebody is leaving, and the register still says things are theirs.
 *
 * **This raises a checklist and notifies. It never moves anything.** Custody changes because a
 * person did something — handed an item over, handed it on, took it back — and every one of those
 * writes a period row and a line of history saying who did it. A hook that quietly returned an
 * item on somebody's last day would write a handover nobody performed, into the one record the
 * company later argues from; and the laptop would still be in their bag. So the answer is a message
 * to the people who can take it back, and the register stays exactly as true as it was.
 *
 * **It is inert without HR.** Nothing here imports HR, depends on it, or assumes it is installed:
 * `hr.person.status_changed` simply never arrives in a workspace that has no HR, and the second
 * caller — `core.member.removed` — is core's own event and needs nothing at all. Both paths check
 * the *inventory* module is switched on for the workspace before doing anything, because an event
 * bus is instance-wide and a workspace that has never enabled this module must not be sent its
 * notifications.
 */
export class OffboardingService {
  constructor(
    private readonly kernel: Kernel,
    private readonly notify: NotifyService,
  ) {}

  /**
   * What one person is still recorded as holding.
   *
   * Read from `assets.custodian_user_id` — denormalised inside the transaction that writes the
   * custody period, and indexed — rather than from an open-period join, which is the same choice
   * `custody.byUser` makes and for the same reason. Archived rows cannot appear: an item somebody
   * holds cannot be archived at all, because `assets.archive` refuses it.
   */
  async held(workspaceId: string, userId: string): Promise<ReturnList['items']> {
    return this.kernel.database.withWorkspace(workspaceId, (tx) =>
      tx
        .select({ id: assets.id, code: assets.code, name: assets.name })
        .from(assets)
        .where(
          and(
            eq(assets.workspaceId, workspaceId),
            eq(assets.custodianUserId, userId),
            isNull(assets.archivedAt),
          ),
        )
        .orderBy(asc(assets.code))
        .limit(MAX_HELD),
    )
  }

  /**
   * Raise the return list, if there is one.
   *
   * Answers with what it found and who it told, so a test can assert both and a caller can log the
   * count. Doing nothing is the ordinary case — most people leave holding nothing — and it is not
   * an error.
   *
   * Redelivery sends the same message again: an event handler is retried, and `core.notifications
   * .create` has no idempotency key. The two events behind this are rare enough that the cost is a
   * duplicate row rather than a stream, and `groupKey` collapses them where a client groups. That
   * is the same trade `module-tracker`'s `due-soon` makes, written down rather than assumed.
   */
  async raise(workspaceId: string, userId: string, departure: Departure): Promise<ReturnList> {
    if (!(await this.kernel.isModuleEnabled(workspaceId, MODULE_ID).catch(() => false)))
      return { items: [], recipients: [] }

    const items = await this.held(workspaceId, userId)
    if (!items.length) return { items: [], recipients: [] }

    // Whoever may take an item back, which is the thing this message is asking for. Not "the
    // admins": a workspace that gave its office manager a custom role did that on purpose.
    const recipients = await membersWithPermission(this.kernel, workspaceId, 'inventory.custody.manage')
    if (!recipients.length) {
      this.kernel.log.warn(
        { module: MODULE_ID, workspaceId, held: items.length },
        'inventory: somebody left holding items and nobody in the workspace may take them back',
      )
      return { items, recipients: [] }
    }

    const who = await this.nameOf(userId)
    const tags = items.slice(0, TAGS_IN_BODY).map((item) => `${item.code} ${item.name}`)
    const rest = items.length - tags.length

    await this.notify.notify({
      workspaceId,
      userIds: recipients,
      type: 'inventory.custody.return_due',
      title:
        departure === 'removed'
          ? `${who} has left the workspace still holding ${items.length === 1 ? 'an item' : `${items.length} items`}`
          : `${who} is leaving and still holds ${items.length === 1 ? 'an item' : `${items.length} items`}`,
      body: rest > 0 ? `${tags.join(', ')} and ${rest} more` : tags.join(', '),
      // One item has an object worth pointing at; several do not, and naming the first would send
      // everybody to one laptop out of five. The URL below is the list either way.
      object: items.length === 1 ? { module: MODULE_ID, type: 'asset', id: items[0]!.id } : null,
      url: items.length === 1 ? assetUrl(items[0]!.id) : `/inventory?custodian=${userId}`,
      data: { userId, departure, assetIds: items.map((item) => item.id) },
      // One group per person, so the two events cannot stack two separate piles about one leaver.
      groupKey: `inventory.return_due.${userId}`,
      // Never to the person leaving: they are being *chased*, and on the `removed` path they are no
      // longer a member of this workspace at all.
      exclude: [userId],
    })

    return { items, recipients }
  }

  /**
   * What to call the person in the sentence.
   *
   * Core is asked, and a failure falls back to "a former member" rather than to the uuid: a
   * notification with a uuid in the middle of it is the product admitting it does not know who it
   * is talking about, and this module already refuses to print one on a screen for the same reason.
   */
  private async nameOf(userId: string): Promise<string> {
    const user = await this.kernel
      .call<{ name?: string | null; email?: string | null } | null>('core.users.get', { id: userId })
      .catch(() => null)
    return user?.name?.trim() || user?.email?.trim() || 'A former member'
  }
}
