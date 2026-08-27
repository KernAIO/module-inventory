import type { BuiltinRole, Principal } from '@kernhq/contracts'
import type { Kernel } from '@kernhq/kernel'

/**
 * Who to tell when the thing that happened belongs to the workspace rather than to a person.
 *
 * Custody notifications have an obvious recipient — the person the item was handed to. A warranty
 * running out on a spare in a cupboard, or a repair nobody has chased, does not: it belongs to
 * whoever looks after the register. There is no "the office manager" field, and inventing one would
 * be a setting somebody has to fill in before the feature works at all, so the question is asked of
 * the permission system instead: **who may actually do the thing this message is asking for.**
 *
 * A warranty notice asks somebody to renew or replace, which is `inventory.asset.manage`. An overdue
 * repair asks somebody to chase the vendor, which is `inventory.repair.manage`. Somebody leaving
 * with a laptop asks somebody to take it back, which is `inventory.custody.manage`. Each message
 * names the key it needs rather than settling for "the admins", because a workspace that gave its
 * office manager a custom role did that on purpose.
 */

/** Most senior first, so the cap below keeps the people most likely to act. */
const ROLE_RANK: Record<BuiltinRole, number> = { owner: 3, admin: 2, member: 1, guest: 0 }

/**
 * How many people one workspace-level notification may reach.
 *
 * A message sent to five thousand people is not a notification, it is a mailing list nobody reads —
 * and on a large instance every member holds `inventory.asset.manage` by default, so an uncapped
 * audience would be exactly that. Twenty is well past any real "who looks after the register" group
 * and small enough that the check below stays a handful of calls rather than one per seat.
 *
 * The cap is applied **after** sorting by role, so the people it keeps are the senior ones rather
 * than whichever rows the database happened to return first.
 */
const RECIPIENT_CAP = 20

interface Member {
  userId: string
  role: BuiltinRole
}

/**
 * The members of a workspace who genuinely hold a permission.
 *
 * Genuinely, not "hold the role it defaults to": `kernel.authz.can` reads custom roles and scope
 * bindings as well as the built-in defaults, so a workspace that took `inventory.repair.manage` away
 * from `member` and gave it to one custom role is answered correctly. Guessing from the role would
 * have been one local call instead of a handful, and would have quietly told the wrong people.
 *
 * Every failure here is swallowed: this decides an audience for a best-effort notification, and a
 * member whose principal core cannot produce right now is one fewer recipient, not a reason for a
 * nightly sweep to stop half-way through a workspace.
 */
export async function membersWithPermission(
  kernel: Kernel,
  workspaceId: string,
  permission: string,
): Promise<string[]> {
  const members = await kernel
    .call<Member[]>('core.workspaces.members', { workspaceId })
    .catch(() => [] as Member[])

  const ordered = [...members].sort((a, b) => (ROLE_RANK[b.role] ?? 0) - (ROLE_RANK[a.role] ?? 0))

  const allowed: string[] = []
  for (const member of ordered) {
    if (allowed.length >= RECIPIENT_CAP) break
    const principal = await kernel
      .call<Principal | null>('core.users.principal', { userId: member.userId })
      .catch(() => null)
    if (!principal) continue
    const can = await kernel.authz
      .can(principal, permission, { kind: 'workspace', workspaceId })
      .catch(() => false)
    if (can) allowed.push(member.userId)
  }
  return allowed
}
