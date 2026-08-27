import type { Principal } from '@kernhq/contracts'
import { KernError, type Kernel } from '@kernhq/kernel'

/**
 * Is this person somebody this workspace can hand a laptop to?
 *
 * **`custody.assign` and `custody.transfer` took any uuid.** The id arrives in the request, nothing
 * looked it up, and the module then wrote it into `custody_periods.user_id` and
 * `assets.custodian_user_id` — the two columns that answer "who is answerable for this" for the rest
 * of the item's life — and sent a notification to it. So a member of one workspace could record a
 * *stranger* as holding company property, and the product would then chase that stranger about it.
 * Every screen renders an id it cannot resolve as "a former member", which is the honest thing for a
 * screen to say and exactly what hides this: the register looks plausible and names nobody real.
 *
 * The check is a question for core, because membership is core's fact and this module has no copy of
 * it. `core.users.principal` answers with one person rather than the workspace's whole roll, which
 * matters on an instance where a workspace has thousands of seats and this runs on every handover.
 *
 * **`active`, not merely present.** An invitation nobody has accepted is not somebody who can be
 * handed a thing, and a suspended account is one the workspace has deliberately shut out.
 *
 * **A failure here refuses rather than waves through.** Every other cross-service call this module
 * makes is best-effort, and this one deliberately is not: swallowing the failure would mean the
 * check silently stops existing exactly while core is unwell, which is indistinguishable from not
 * having written it. `UNAVAILABLE` is 503 and says the true thing — the answer is not knowable right
 * now — where a 400 would tell somebody their colleague is not a member.
 */
export async function requireWorkspaceMember(
  kernel: Kernel,
  workspaceId: string,
  userId: string,
): Promise<void> {
  let principal: Principal | null
  try {
    principal = await kernel.call<Principal | null>('core.users.principal', { userId })
  } catch (err) {
    kernel.log.warn(
      { err: err instanceof Error ? err.message : String(err), workspaceId },
      'inventory: could not check whether the new custodian is a member',
    )
    throw new KernError(
      'UNAVAILABLE',
      'Who belongs to this workspace cannot be checked right now. Try again in a moment.',
    )
  }

  const member = (principal?.memberships ?? []).some(
    (m) => m.workspaceId === workspaceId && m.status === 'active',
  )
  if (!member)
    throw KernError.badRequest(
      'That person is not a member of this workspace, so nothing can be handed to them.',
    )
}
