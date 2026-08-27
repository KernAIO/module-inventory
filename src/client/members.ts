import type { CoreMember } from './core-api.js'

/**
 * Turning a stored user id into a name a person recognises.
 *
 * Custody rows and history rows both carry plain uuids — a module keeps cross-schema ids plain, and
 * a name copied into this module's tables would be a name that goes stale the day somebody marries.
 * So every screen that shows *who* resolves the id here, against the members core says the workspace
 * has right now.
 *
 * **The list is a request, and a request has three answers, not one.** This file resolved an
 * unknown id straight to "a former member" without ever asking whether the list had arrived — so
 * for the first moments of every panel, before the members request came back, an entire timeline
 * read "A former member handed it to A former member", and it stayed that way for ever if the
 * request failed. The claim was false in both cases: nobody had left. `status` is what separates
 * *we do not know yet*, *we could not find out* and *this person really is gone*, and the three are
 * rendered as three different things.
 *
 * Pure, and here rather than inside a component, for the reason `price.ts` and `timeline.ts` are:
 * a `.svelte` file drags a compiler behind it and cannot be unit-tested, and "what does this id
 * read as" is a fact with a right answer.
 */

/** Where the members request has got to. `ready` is the only state whose absences mean anything. */
export type DirectoryStatus = 'loading' | 'error' | 'ready'

export interface Directory {
  /** Everybody the workspace has, by user id. Empty until `status` is `ready`. */
  byId: ReadonlyMap<string, CoreMember>
  /** The same ids as a set, which is what `actorKind` asks about. */
  ids: ReadonlySet<string>
  /** Whether this directory is in a position to say that somebody is missing from it. */
  status: DirectoryStatus
}

export function directory(members: readonly CoreMember[], status: DirectoryStatus = 'ready'): Directory {
  const byId = new Map<string, CoreMember>()
  for (const member of members) byId.set(member.userId, member)
  return { byId, ids: new Set(byId.keys()), status }
}

/**
 * A TanStack query's flags as the one word this file needs.
 *
 * Here rather than inlined into each screen because the mapping has a trap in it: a query with
 * `enabled: false` reports `isPending` for ever, so "not pending" is not the same question as
 * "arrived". `isSuccess` is the only flag that means the data is in hand.
 */
export function directoryStatus(query: { isSuccess: boolean; isError: boolean }): DirectoryStatus {
  if (query.isError) return 'error'
  return query.isSuccess ? 'ready' : 'loading'
}

/**
 * What to call somebody.
 *
 * `name` is nullable in core — an invited person who has never signed in has an email and nothing
 * else — so the email is the fallback rather than an empty label. A blank name is treated as absent
 * for the same reason: a row whose person column is empty reads as a bug in the register.
 */
export function displayName(member: CoreMember | undefined): string | null {
  if (!member) return null
  const name = member.user.name?.trim()
  return name || member.user.email
}

/**
 * The five answers to "who is this id", before any of them is turned into words.
 *
 * `person` is the only one carrying a name. The other four each say something different and only
 * one of them is a claim about the *person*:
 *
 * - `loading` — the workspace's members have not arrived. Nothing is known yet, and saying anything
 *   about who this is would be inventing it.
 * - `unknown` — the members request failed. Somebody did this; which somebody cannot be found out
 *   right now, and that is a fact about the request rather than about them.
 * - `former` — the list is in hand and this id is not in it. *Now* "a former member" is true.
 * - `system` — there is no id at all: a nightly sweep, an import, an offboarding hook.
 */
export type NameKind = 'person' | 'loading' | 'unknown' | 'former' | 'system'

export interface ResolvedName {
  kind: NameKind
  /** The name, and only for `person`. Everything else has no name to give. */
  name: string | null
}

export function resolveName(userId: string | null, dir: Directory): ResolvedName {
  if (!userId) return { kind: 'system', name: null }
  const name = displayName(dir.byId.get(userId))
  if (name) return { kind: 'person', name }
  if (dir.status === 'loading') return { kind: 'loading', name: null }
  if (dir.status === 'error') return { kind: 'unknown', name: null }
  return { kind: 'former', name: null }
}

/** The words a screen supplies for the four answers that have no name of their own. */
export interface NameWords {
  loading: string
  unknown: string
  former: string
  system: string
}

/**
 * The one place an unresolvable id is turned into words.
 *
 * The words are given by the caller because they are translated strings, and this file holds no
 * strings — it decides *which* of the five answers applies and leaves the wording to the catalogue.
 * Never the raw uuid: a sentence with a uuid in the middle of it is the interface admitting it does
 * not know what it is talking about.
 */
export function nameOf(userId: string | null, dir: Directory, words: NameWords): string {
  const resolved = resolveName(userId, dir)
  return resolved.kind === 'person' ? (resolved.name as string) : words[resolved.kind]
}
