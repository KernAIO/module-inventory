/**
 * Putting a value somebody typed inside a sentence somebody else translated.
 *
 * **A Latin value dropped into a Persian or Arabic sentence renders backwards, and nothing about
 * the source says so.** The Unicode bidirectional algorithm resolves the *neutral* characters at a
 * run's edges — a quote, a bracket, a full stop, a hyphen — against the paragraph, not against the
 * value they were typed as part of. So in an RTL paragraph:
 *
 * ```
 * MacBook Pro 14" به Bruno Weber تحویل داده شد   →   … ﻪﺑ "MacBook Pro 14
 * یادداشت: For the Berlin trip.                  →   .For the Berlin trip :ﺖﺷﺍﺩﺩﺎﯾ
 * ```
 *
 * The inch mark leaves the name it belongs to and lands against the next word; the full stop of an
 * English note ends up at the head of it. Both were reproduced with `fribidi` against this module's
 * own catalogue before this file existed — an asset tag, a serial number and a Latin name inside
 * `history_changed`, `held_by` and every `{name}` toast.
 *
 * `isolate()` is the fix the standard provides: **U+2068 FIRST STRONG ISOLATE** opens a run whose
 * direction is taken from the value's own first strong character, and **U+2069 POP DIRECTIONAL
 * ISOLATE** closes it. Neutrals inside the run resolve against the value; the run as a whole is
 * placed as one unit in the sentence. First-strong rather than a forced LTR, because a Persian
 * asset name inside a Persian sentence must go on reading right-to-left — the value decides, which
 * is the whole point.
 *
 * **Where CSS can do it instead, CSS does it.** A value rendered into its own element — an asset
 * tag in a `<code>`, a serial in a `<span class="ltr">` — carries `unicode-bidi: isolate` and needs
 * nothing from here. This is for the other case: `t('history_changed', { from, to })` returns one
 * string with the values already substituted, and there is no element left to put a rule on.
 *
 * Pure, and a plain module rather than something inside a component, for the reason `price.ts` and
 * `timeline.ts` are: a `.svelte` file drags a compiler behind it and cannot be unit-tested.
 */

/**
 * Written as escapes, never as the characters themselves.
 *
 * These are invisible. A literal one in a source file is a character nobody can see in a diff, in
 * a review, or in an editor — and `price.ts` already strips a class of them precisely because they
 * ride along on pasted text without anybody noticing.
 */
/** U+2068 FIRST STRONG ISOLATE — direction taken from the value's own first strong character. */
export const FSI = '\u2068'
/** U+2069 POP DIRECTIONAL ISOLATE. */
export const PDI = '\u2069'

/**
 * The isolates (U+2066–U+2069) and the embeddings and overrides (U+202A–U+202E).
 *
 * Deliberately **not** LRM and RLM (U+200E, U+200F). Those are marks rather than containers: they
 * cannot be left unbalanced, and `Intl.DateTimeFormat` puts them inside an Arabic date on purpose —
 * `14‏/03‏/2027` is CLDR's own output, and stripping them would break the date to fix nothing.
 */
const CONTROLS = /[\u2066-\u2069\u202a-\u202e]/g

/**
 * One value, safe to interpolate into a translated sentence.
 *
 * An empty or absent value comes back as an empty string rather than as two invisible characters:
 * a placeholder nothing filled should leave no trace in the sentence, and `{name}` is very often
 * `asset?.name ?? ''` at the call site.
 *
 * Anything the value already carries is stripped first. Controls arrive by being pasted out of an
 * RTL document — the same reason `price.ts` strips them before parsing a number — and an unbalanced
 * one inside an isolate would reorder the rest of the sentence rather than the rest of the value.
 */
export function isolate(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const text = String(value).replace(CONTROLS, '')
  return text ? `${FSI}${text}${PDI}` : ''
}

/**
 * Isolate every value of a parameter bag, for the common case of a whole `t()` call.
 *
 * `t(key, isolated({ actor, person }))` rather than four `isolate()` calls at the site, so a
 * parameter added to a message later is isolated by construction instead of by remembering.
 */
export function isolated<K extends string>(
  params: Record<K, string | number | null | undefined>,
): Record<K, string> {
  const out = {} as Record<K, string>
  for (const key of Object.keys(params) as K[]) out[key] = isolate(params[key])
  return out
}
