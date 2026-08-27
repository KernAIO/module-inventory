/**
 * Turning a refusal from the server into a sentence in the reader's own language.
 *
 * **Every actionable failure this module could produce reached the user in English, in all five
 * locales.** Eight call sites were written as `toast.error(error.message || t('common.error'))`,
 * and `error.message` is prose the *server* wrote: "Somebody changed who is holding this a moment
 * before you did. Reload to see where it is now." That is the most useful sentence in the module
 * and a Persian reader was shown it in English, at exactly the moment they needed to understand it.
 * The comments at those call sites even said so — that the server's message was "the actionable
 * one" — which was true, and was an argument for translating it rather than for printing it.
 *
 * The thing a client can translate is the **reason**, not the message. `KernError.conflict(message,
 * reason)` has carried one since it was written, and `kernErrorToORPC` puts it in `data.reason`
 * precisely so a client can branch on it: `inventory.custody.already_held` is a stable token that
 * ships with the contract, where the sentence is prose that changes when somebody rewords it. So:
 *
 *   1. a `reason` this module knows → its own translated sentence;
 *   2. otherwise the error **code** → the sentence that class of failure deserves;
 *   3. otherwise a generic failure, and the server's own words underneath it.
 *
 * Step three is not a shrug. Dropping the server's message entirely would hide the one clue
 * somebody could act on when the reason is one this build has never heard of — a newer server, an
 * error from core rather than from here. It is shown as *detail*, under a sentence that at least
 * names what failed, rather than as the whole of what the interface has to say.
 *
 * Pure and string-free: this file decides *which* key, `i18n.ts` holds the words, and a `.svelte`
 * file cannot be unit-tested. `errorMessage()` at the bottom is the one function the screens call.
 *
 * The one import is a number from the contract — the same file the server reads it from — because a
 * limit a sentence refuses to name is a limit nobody can plan around. It brings no runtime with it;
 * what this file still must never reach for is `i18n.ts`, which drags a Svelte compiler in behind it.
 */

import { MAX_LIVE_CATEGORIES } from '../contract/models.js'

/** What oRPC hands a screen. `code` is the contract's `ErrorCode`; `data` is what the server put in it. */
export interface ServerError {
  code?: unknown
  message?: unknown
  data?: unknown
  status?: unknown
}

/**
 * The reason token, out of wherever this particular transport put it.
 *
 * `data.reason` is the real one — that is what `kernErrorToORPC` folds it into. `reason` on the
 * error itself is read too, because that is where a `KernError` thrown in-process carries it, and
 * the mock in this package is neither: a demo that could not reproduce a translated conflict would
 * be a demo that hides the branch this file exists for.
 */
export function reasonOf(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null
  const e = err as ServerError & { reason?: unknown }
  const data = e.data as { reason?: unknown } | undefined
  const found = (data && typeof data === 'object' ? data.reason : undefined) ?? e.reason
  return typeof found === 'string' && found ? found : null
}

/** The `ErrorCode` the server refused with, if this is one of its errors at all. */
export function codeOf(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null
  const { code } = err as ServerError
  return typeof code === 'string' && code ? code : null
}

/**
 * Whether a `BAD_REQUEST` is oRPC saying the *input* was malformed, or a service refusing.
 *
 * **Both arrive as `BAD_REQUEST`, and only one of them is about the form.** oRPC throws
 * `ORPCError('BAD_REQUEST', { message: 'Input validation failed', data: { issues } })` when a zod
 * schema rejects the input — that one really is "check what you entered". The ones this module's
 * own services throw are not:
 *
 *   - "That person is not a member of this workspace, so nothing can be handed to them."
 *   - "That file has not finished uploading yet."
 *   - "That file is not one this workspace can attach."
 *   - "That page marker is not one this list issued"
 *   - "That category is not one this workspace has."
 *   - "A repair cannot be sent in the future."
 *
 * Every field on those forms is fine. Sending somebody to re-read them is worse than saying
 * nothing, because it is a confident wrong instruction: nobody finds the mistake, because there
 * isn't one. `issues` is the one structural difference between the two, so it is what decides.
 *
 * This is a stopgap, and the report that came with it says so. The right fix is a **stable reason
 * token** on each of those four — `KernError.badRequest` takes `details` where `conflict` takes a
 * `reason`, so today they carry nothing a client can branch on and the server's English prose is
 * the only clue that survives. Once they carry one, they belong in `REASON_KEYS` with a sentence
 * each in all five languages, and this branch goes back to being about validation alone.
 */
export function isInputValidation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const data = (err as ServerError).data as { issues?: unknown } | undefined
  return Boolean(data && typeof data === 'object' && Array.isArray(data.issues))
}

/** Whatever the server said, for the detail line under a failure nothing here recognises. */
export function messageOf(err: unknown): string | null {
  if (!err) return null
  if (typeof err === 'string') return err.trim() || null
  if (typeof err !== 'object') return null
  const { message } = err as ServerError
  return typeof message === 'string' && message.trim() ? message.trim() : null
}

/**
 * Every reason this module's server actually throws, and the sentence each one earns.
 *
 * Not "every reason imaginable": each key here is one this package's own services produce, and
 * `errors.test.ts` reads them out of `src/server` to hold the two lists together. A sentence for a
 * refusal that cannot happen is dead weight nobody will ever notice is wrong; a refusal with no
 * sentence is English on somebody's screen, which is the defect this file was written for.
 *
 * The wording is what the reader can *do*, in the same voice as the rest of the module. A lost race
 * says to look again; a conflict of state says which handover to use instead.
 */
const REASON_KEYS: Record<string, string> = {
  'inventory.custody.conflict': 'error_custody_conflict',
  'inventory.custody.archived': 'error_custody_archived',
  'inventory.custody.already_held': 'error_custody_already_held',
  'inventory.custody.not_held': 'error_custody_not_held',
  'inventory.asset.still_held': 'error_asset_still_held',
  'inventory.asset.under_repair': 'error_asset_under_repair',
  'inventory.repair.already_open': 'error_repair_already_open',
  'inventory.repair.archived': 'error_repair_archived',
  'inventory.repair.already_complete': 'error_repair_already_complete',
  'inventory.repair.returned_before_sent': 'error_repair_returned_before_sent',
  'inventory.category.name_taken': 'error_category_name_taken',
  'inventory.category.order_stale': 'error_category_order_stale',
  'inventory.category.limit_reached': 'error_category_limit_reached',
}

export const reasonKeys = (): readonly string[] => Object.keys(REASON_KEYS)

/**
 * The one refusal whose sentence has a number in it, and where that number comes from.
 *
 * A limit stated as "quite a lot" is not stated. `KernError.conflict` carries a reason and no data,
 * so the server cannot hand the figure over — and it does not need to: it is a constant in the
 * contract, which is the same file both halves read. Passed through `t`, it goes through
 * `Intl.NumberFormat`, so a Persian reader is shown ۵۰۰ rather than 500.
 */
const REASON_VALUES: Record<string, Record<string, string | number>> = {
  'inventory.category.limit_reached': { max: MAX_LIVE_CATEGORIES },
}

/**
 * The sentence a whole class of failure earns, when no reason narrows it further.
 *
 * `NOT_FOUND` and `MODULE_DISABLED` are the two worth spelling out. A 404 here almost always means
 * somebody else archived or removed the row while this screen was open, so "it is no longer there —
 * reload" is both true and the next step. `MODULE_DISABLED` is what a workspace gets when Inventory
 * is switched off underneath it, and "Forbidden" would be the wrong word for it entirely.
 *
 * A **disabled capability answers 404, not 403** — that is the module contract — so a capability
 * switched off mid-session lands on `NOT_FOUND` here, which is the same "it is not there any more,
 * look again" sentence, and correctly so.
 */
const CODE_KEYS: Record<string, string> = {
  NOT_FOUND: 'error_not_found',
  FORBIDDEN: 'error_forbidden',
  MODULE_DISABLED: 'error_module_disabled',
  CONFLICT: 'error_conflict',
  // Reached only when the request really did fail validation — `errorLine` peels off the refusals
  // first. `VALIDATION` is here because the code itself is the claim; `BAD_REQUEST` is not.
  BAD_REQUEST: 'error_bad_request',
  VALIDATION: 'error_bad_request',
  UNAUTHORIZED: 'error_unauthorized',
  RATE_LIMITED: 'error_rate_limited',
  UNAVAILABLE: 'error_unavailable',
}

/**
 * Which sentence to show, and whether the server's own words go under it.
 *
 * `detail` is filled only for the fallback: when this module named the failure itself, repeating
 * the server's English beneath its own Persian sentence would undo the translation.
 */
export interface ErrorLine {
  /** A key for `t()`, always one this module's catalogue has. */
  key: string
  /** The server's own sentence, for a failure nothing here recognised. Null otherwise. */
  detail: string | null
  /** What the sentence's placeholders need. Absent for every key that has none. */
  values?: Record<string, string | number>
}

export function errorLine(err: unknown): ErrorLine {
  const reason = reasonOf(err)
  const byReason = reason ? REASON_KEYS[reason] : undefined
  if (byReason) {
    const values = reason ? REASON_VALUES[reason] : undefined
    return values ? { key: byReason, detail: null, values } : { key: byReason, detail: null }
  }

  const code = codeOf(err)

  // A `BAD_REQUEST` with no validation issues on it is a service refusing something, not a schema
  // rejecting a field — so it gets a sentence that does not send anybody back to a form that is
  // fine, and the server's own explanation as the detail. That prose is English until those four
  // refusals carry a reason token; an English clue under a translated sentence is worse than a
  // translated one and much better than a confident wrong instruction.
  if (code === 'BAD_REQUEST' && !isInputValidation(err))
    return { key: 'error_refused', detail: messageOf(err) }

  const byCode = code ? CODE_KEYS[code] : undefined
  if (byCode) return { key: byCode, detail: null }

  // Nothing recognised it — a newer server, a failure from core, or the network. The generic
  // sentence names what happened and the server's words are kept as the only actionable clue left.
  return { key: 'error_unknown', detail: messageOf(err) }
}

/**
 * The one call a screen makes: `toast.error(errorMessage(error, t))`.
 *
 * `t` is passed in rather than imported so this file goes on importing nothing — `i18n.ts` reaches
 * `@kernhq/ui`, and that entry point drags a Svelte compiler into whatever imports it, which is
 * what makes a helper untestable.
 */
export function errorMessage(
  err: unknown,
  translate: (key: string, values?: Record<string, string | number>) => string,
): string {
  const line = errorLine(err)
  const sentence = translate(line.key, line.values)
  return line.detail ? `${sentence} — ${line.detail}` : sentence
}
