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

/**
 * The currencies a money field offers, in one place because two forms ask for one.
 *
 * The asset form and the repair form put the same question — what is this amount in — and a second
 * copy of the list is a list that gains a currency in one form and not the other. Codes rather than
 * names: ISO 4217 is what the column stores, and a currency name is one more thing to translate
 * five times for no gain over the code somebody already reads on their own bank statement.
 *
 * **This list was `['USD', 'EUR', 'IRR', 'AED']` in a product that ships Turkish.** A Turkish
 * workspace could not record what it paid for anything in lira: the contract takes any three-letter
 * code (`z.string().length(3)`) and the server stores whatever arrives, so the shortage was the
 * picker's alone — four options, one of which was missing for one of the five languages on the
 * language menu. TRY, and the currency of every other locale this module ships, is now here.
 *
 * The order is deliberate and is not alphabetical: the currency of each shipped language first, in
 * the order the locales are listed everywhere else in this package (en, ar, de, fa, tr) — so USD,
 * AED, EUR, IRR, TRY — then the ones a company in those places is most likely to have paid an
 * invoice in. A picker sorted A–Z puts AED above USD for a reader in Berlin, which is tidy and
 * useless.
 *
 * **The comment said that while the list said `USD, EUR, AED, TRY, IRR`**, which is no order at
 * all — en, de, ar, tr, fa — so the rule a sixth currency was supposed to be filed under described
 * something that had never been true. `price.test.ts` now asserts the first five, because a stated
 * order nothing checks drifts back the first time somebody appends a code.
 *
 * It is still a list, not the whole of ISO 4217: all 180 codes in a `<select>` is not a kindness.
 *
 * **What a new asset defaults to is deliberately nothing.** The obvious improvement on "the first
 * code in the list" is "whatever this workspace uses", and that is right — but a workspace currency
 * does not exist: `InventorySettings` holds the tag prefix, the tag padding and the two notice
 * windows, and nothing else, so `defaultCurrency` is a contract change rather than something a
 * picker can invent. The tempting shortcut is to read it off the reader's locale, and that is
 * *worse* than no default: two colleagues in one workspace, one reading German and one reading
 * Turkish, would be handed different pre-selected currencies for the same register, notice nothing,
 * and store EUR against one laptop and TRY against the next. A currency is a fact about the
 * company, not about the language somebody happens to read the screen in. So the forms seed from
 * the *record* — a repair inherits its asset's currency, an edit keeps its own — and a new asset
 * starts empty, which asks the question instead of answering it wrongly.
 */
export const CURRENCIES = [
  'USD',
  'AED',
  'EUR',
  'IRR',
  'TRY',
  'GBP',
  'SAR',
  'QAR',
  'KWD',
  'EGP',
  'CHF',
  'SEK',
  'NOK',
  'DKK',
  'PLN',
  'CAD',
  'AUD',
  'JPY',
  'CNY',
  'INR',
] as const

/**
 * The options both money fields offer, built once.
 *
 * The empty option is first and is a real answer: an asset with no price has no currency either,
 * and a picker with no way back to "none" is a field somebody can fill in and never clear.
 */
export function currencyOptions(noneLabel: string): Array<{ value: string; label: string }> {
  return [{ value: '', label: noneLabel }, ...CURRENCIES.map((code) => ({ value: code, label: code }))]
}

const EXPONENTS: Map<string, number> = new Map()

/**
 * How many decimal places this currency has — asked of the currency, never assumed to be two.
 *
 * **This module stored ¥1000 as ¥10 and every KWD amount ten times too small.** `parsePrice` and
 * `formatPrice` both hard-coded 1/100, and the picker offers JPY, which has *no* minor unit, and
 * KWD, which has *three* decimal places. So `1000` typed into a yen field became 100000 minor
 * units, read back as `1000.00`, and was ¥100 000 to anything that read the column honestly — a
 * silent 100× on exactly the shape of field this file was rewritten to stop silently mangling.
 *
 * **IRR is the one that matters most here**, because it is the currency of a language this module
 * ships: the rial has no minor unit either, so a Persian workspace was the default victim.
 *
 * CLDR knows each currency's exponent and `Intl` will hand it over, so nothing is tabulated: a
 * currency added to `CURRENCIES` next year gets the right answer without anybody remembering this
 * function exists. A code `Intl` refuses, or one it has never heard of, falls back to two — which
 * is what ISO 4217 assigns by default, and is the only guess available.
 *
 * The locale is fixed at `'en'` deliberately: the exponent is a fact about the *currency*, and
 * asking under the reader's locale would make the same money parse differently for two colleagues.
 */
export function minorUnitExponent(currency: string | null | undefined): number {
  if (!currency) return 2
  const cached = EXPONENTS.get(currency)
  if (cached !== undefined) return cached
  let exponent = 2
  try {
    // `maximumFractionDigits` is optional in the DOM lib and always present in practice for a
    // currency formatter; `??` is what keeps the two type-checks agreeing about that.
    exponent =
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ??
      2
  } catch {
    // A malformed code — the contract takes any three letters and the picker is not the only way
    // in. Two decimals is ISO 4217's own default and keeps the field usable.
  }
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 4) exponent = 2
  EXPONENTS.set(currency, exponent)
  return exponent
}

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
 *
 * `currency` decides how many decimal places the amount is allowed and what it is scaled by. More
 * fractional digits than the currency has is a **rejection, not a rounding**: `19.99` in a yen
 * field is not ¥20, it is somebody who has not noticed which field they are in, and quietly
 * storing a number nobody typed is the whole class of failure this file exists to end. Omitting
 * `currency` keeps two decimals, which is what an amount with no currency on it has always meant.
 *
 * The scaled integer is built by **concatenating digits**, never by multiplying: `19.99 * 100` is
 * `1998.9999999999998` in a double, and the `Math.round` that used to hide it would have had to
 * hide `1234.567 * 1000` too. Digits in, digits out, and no float on the path at all.
 */
export function parsePrice(raw: string, locale: string, currency?: string | null): PriceResult {
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

  const exponent = minorUnitExponent(currency)
  // A currency with no minor unit has no decimal point either, so `frac` of any length fails here.
  if (frac !== undefined && frac.length > exponent) return { ok: false }

  const digits = group ? whole.split(group).join('') : whole
  const minor = Number(`${digits}${(frac ?? '').padEnd(exponent, '0')}`)
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
 * out of here is exactly what goes back in, for the currency the amount is in.
 */
export function formatPrice(
  minor: number | null | undefined,
  locale: string,
  currency?: string | null,
): string {
  if (minor === null || minor === undefined) return ''
  const exponent = minorUnitExponent(currency)
  const value = minor / 10 ** exponent
  try {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
      useGrouping: false,
    }).format(value)
  } catch {
    return String(value)
  }
}

/**
 * The amount the "enter an amount like…" error holds up as an example.
 *
 * It has to be an amount the field would *accept*, or the error tells somebody to type something
 * that is also rejected. `1234.56` was hard-coded, so a yen field said "Enter an amount like
 * 1234.56" and then refused it. Built from the exponent instead: `1234` in yen, `1234.567` in
 * dinars, and the reader's own separators and digits around it either way.
 */
export function priceExample(locale: string, currency?: string | null): string {
  const exponent = minorUnitExponent(currency)
  return formatPrice(Number(`1234${'567'.slice(0, exponent).padEnd(exponent, '0')}`), locale, currency)
}
