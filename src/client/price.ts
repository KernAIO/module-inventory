/**
 * Reading and writing a price the way the person in front of the form writes it.
 *
 * **This is the file that shipped a silent 100× data loss.** The dialog parsed a price with
 * `Number.parseFloat(raw.replace(',', '.'))`, and `String.replace` with a string pattern replaces
 * only the *first* match — so a German, Turkish or Persian reader typing `1.234,56`, which is how
 * three of the five languages this module ships write twelve hundred, got `1.23456` parsed to
 * `1.23` and stored as €1.23. `1,234.56` in English became the same. Neither said anything: the
 * old parser returned `null` for garbage and the asset was simply saved with no price at all, so
 * `abc` and `-5` both vanished without an error.
 *
 * So: no separator is assumed, the locale is asked what its own are, and anything that is not a
 * plain non-negative number in *that* locale comes back as a rejection the form can show. There is
 * no third outcome where a wrong number is stored quietly.
 *
 * Pure on purpose — the locale arrives as an argument rather than being read from `@kernhq/ui`.
 * That entry point reaches Svelte components, and a parser that drags a compiler behind it is a
 * parser nothing can unit-test. The dialog passes `messageLocale()`.
 */

/** `minor: null` is a real answer — an empty field means "no price", not a bad one. */
export type PriceResult = { ok: true; minor: number | null } | { ok: false }

interface Separators {
  group: string
  decimal: string
}

const SEPARATORS: Map<string, Separators> = new Map()

/**
 * What this locale's own numbers look like, asked of `Intl` rather than tabulated here.
 *
 * A table of separators per language is a table that is wrong for the sixth language somebody adds.
 * Measured for the five shipped today: en and ar group with `,` and point with `.`, de and tr are
 * the other way round, and fa uses `٬` and `٫`.
 */
function separatorsFor(locale: string): Separators {
  const cached = SEPARATORS.get(locale)
  if (cached) return cached
  const found: Separators = { group: ',', decimal: '.' }
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(12345.6)
    found.group = parts.find((part) => part.type === 'group')?.value ?? found.group
    found.decimal = parts.find((part) => part.type === 'decimal')?.value ?? found.decimal
  } catch {
    // A runtime that cannot name this locale must not make the field unusable; English separators
    // are the fallback, and a wrong guess shows an error rather than storing a wrong number.
  }
  SEPARATORS.set(locale, found)
  return found
}

/**
 * A Persian keyboard produces ۱۲۳ and an Arabic one ١٢٣, and `Number` reads neither.
 *
 * Same fold HR's employee counter does, and for the same reason: a person typing the digits of
 * their own language into their own language's form must not be told their input is not a number.
 */
const toLatinDigits = (value: string) =>
  value
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))

/** Bidi controls ride along on anything copied out of an RTL document and are never separators. */
const BIDI = /[‎‏؜⁦-⁩]/g

/**
 * A group separator always precedes exactly three digits.
 *
 * This is the rule that stops the quiet 100×: in German `.` groups, so `1234.56` is not "one
 * thousand two hundred and thirty-four point five six" — it is not a well-formed German number at
 * all. Stripping the dot would store €12,345.60 for a €1,234.56 laptop and nothing would say so.
 * Rejecting it puts the question back to the person, which is the only honest answer available.
 */
function isGroupedInteger(text: string, group: string): boolean {
  if (/^\d+$/.test(text)) return true
  if (!group || !text.includes(group)) return false
  const [first, ...rest] = text.split(group)
  if (first === undefined || !/^\d{1,3}$/.test(first)) return false
  return rest.every((chunk) => /^\d{3}$/.test(chunk))
}

/**
 * Minor units are the wire format; the form takes what somebody reads off the receipt.
 *
 * Returns `{ ok: false }` for anything that is not a non-negative number in `locale` — including a
 * negative one, which the contract has no way to mean and the old parser dropped in silence.
 */
export function parsePrice(raw: string, locale: string): PriceResult {
  const text = toLatinDigits(raw).replace(BIDI, '').trim()
  if (!text) return { ok: true, minor: null }

  const { group, decimal } = separatorsFor(locale)
  const pieces = text.split(decimal)
  if (pieces.length > 2) return { ok: false }

  let whole = pieces[0] ?? ''
  const frac = pieces[1]
  // "‚50" is how somebody writes half a unit; the leading zero is implied, not missing.
  if (whole === '' && frac !== undefined) whole = '0'

  if (!isGroupedInteger(whole, group)) return { ok: false }
  if (frac !== undefined && !/^\d+$/.test(frac)) return { ok: false }

  const digits = group ? whole.split(group).join('') : whole
  const value = Number(`${digits}.${frac ?? '0'}`)
  if (!Number.isFinite(value)) return { ok: false }

  const minor = Math.round(value * 100)
  // A price that cannot survive the round trip through a double is not a price anybody typed.
  if (!Number.isSafeInteger(minor)) return { ok: false }
  return { ok: true, minor }
}

/**
 * The stored price, back in the field, in the reader's own numbers.
 *
 * The edit form has to seed itself from `priceMinor`, and seeding it with `1234.56` for a German
 * reader would make them look at a number their own locale says is €123,456 — then `parsePrice`
 * would reject it on the grouping rule and they would be told their own data is invalid. What comes
 * out of here is exactly what goes back in.
 */
export function formatPrice(minor: number | null | undefined, locale: string): string {
  if (minor === null || minor === undefined) return ''
  try {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      useGrouping: false,
    }).format(minor / 100)
  } catch {
    return String(minor / 100)
  }
}
