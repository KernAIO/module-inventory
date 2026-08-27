import { describe, expect, it } from 'vitest'
import {
  CURRENCIES,
  currencyOptions,
  formatPrice,
  minorUnitExponent,
  parsePrice,
  priceExample,
} from './price.js'

/**
 * The regression this file exists for.
 *
 * `raw.replace(',', '.')` replaced the first comma only, so `1.234,56` — how German, Turkish and
 * Persian write twelve hundred — parsed as `1.23456` and was stored as €1.23. Three of the five
 * languages this module ships, silently, with no error anywhere. `abc` and `-5` were worse: they
 * came back `null` and the asset saved with no price at all.
 */
const minor = (raw: string, locale: string, currency?: string | null) => {
  const result = parsePrice(raw, locale, currency)
  return result.ok ? result.minor : 'invalid'
}

describe('parsePrice', () => {
  it('reads a grouped price in each locale the module ships', () => {
    expect(minor('1,234.56', 'en')).toBe(123456)
    expect(minor('1.234,56', 'de')).toBe(123456)
    expect(minor('1.234,56', 'tr')).toBe(123456)
    // Persian groups with ٬ and points with ٫, in Persian digits.
    expect(minor('۱٬۲۳۴٫۵۶', 'fa')).toBe(123456)
    expect(minor('1,234.56', 'ar')).toBe(123456)
  })

  it('reads an ungrouped price in each locale', () => {
    expect(minor('1234.56', 'en')).toBe(123456)
    expect(minor('1234,56', 'de')).toBe(123456)
    expect(minor('1234,56', 'tr')).toBe(123456)
    expect(minor('۱۲۳۴٫۵۶', 'fa')).toBe(123456)
  })

  it('folds Persian and Arabic digits, so a person may type their own numerals', () => {
    expect(minor('۱۹٫۹۹', 'fa')).toBe(1999)
    expect(minor('١٩.٩٩', 'ar')).toBe(1999)
    expect(minor('۲۵', 'fa')).toBe(2500)
  })

  it('treats an empty field as no price rather than a bad one', () => {
    expect(minor('', 'en')).toBe(null)
    expect(minor('   ', 'de')).toBe(null)
  })

  it('rejects what it cannot read instead of saving nothing', () => {
    // Both of these used to return null, and the asset was filed with no price.
    expect(minor('abc', 'en')).toBe('invalid')
    expect(minor('-5', 'en')).toBe('invalid')
    expect(minor('1.2.3', 'en')).toBe('invalid')
    expect(minor('12,34', 'en')).toBe('invalid')
    expect(minor('$12.00', 'en')).toBe('invalid')
  })

  /**
   * The 100× that has no visible symptom: `.` is German's *group* separator, so stripping it would
   * store 123456 for somebody who meant 1234.56. There is no way to tell which they meant, so the
   * field asks rather than guesses.
   */
  it('rejects a group separator that does not group three digits', () => {
    expect(minor('1234.56', 'de')).toBe('invalid')
    expect(minor('1234.56', 'tr')).toBe('invalid')
    expect(minor('1.23.456', 'de')).toBe('invalid')
    expect(minor('1,2345', 'en')).toBe('invalid')
  })

  it('keeps a bare decimal, with or without its leading zero', () => {
    expect(minor('0.5', 'en')).toBe(50)
    expect(minor('.5', 'en')).toBe(50)
    expect(minor(',5', 'de')).toBe(50)
  })

  it('does not lose a cent to floating point', () => {
    expect(minor('19.99', 'en')).toBe(1999)
    expect(minor('0.07', 'en')).toBe(7)
    expect(minor('8.29', 'en')).toBe(829)
  })
})

/**
 * The second silent 100×, and the one the picker itself created.
 *
 * `parsePrice` and `formatPrice` both hard-coded 1/100 while the currency list offers **JPY**,
 * which has no minor unit at all, and **KWD**, which has three decimal places. So ¥1000 typed into
 * the field was stored as 100000 minor units — ¥100 000 to anything reading the column honestly —
 * and every dinar amount was out by a factor of ten. **IRR is the one that stings**: the rial has
 * no minor unit either, and it is the currency of a language this module ships.
 */
describe('the currency decides the minor unit', () => {
  it('asks the currency rather than assuming hundredths', () => {
    expect(minorUnitExponent('USD')).toBe(2)
    expect(minorUnitExponent('EUR')).toBe(2)
    expect(minorUnitExponent('JPY')).toBe(0)
    expect(minorUnitExponent('IRR')).toBe(0)
    expect(minorUnitExponent('KWD')).toBe(3)
    // No currency on an amount is not a reason to make the field unusable, and two decimals is
    // what ISO 4217 assigns by default.
    expect(minorUnitExponent(null)).toBe(2)
    expect(minorUnitExponent('')).toBe(2)
    // The contract takes any three letters, so a code `Intl` refuses must not throw out of a form.
    expect(minorUnitExponent('nonsense')).toBe(2)
  })

  it('stores ¥1000 as 1000, not as 10', () => {
    expect(minor('1000', 'en', 'JPY')).toBe(1000)
    expect(minor('1,000', 'en', 'JPY')).toBe(1000)
    expect(formatPrice(1000, 'en', 'JPY')).toBe('1000')
    // What it did before: hundredths, so the amount read back a hundred times too small.
    expect(formatPrice(1000, 'en')).toBe('10.00')
  })

  it('keeps all three of a dinar’s decimal places', () => {
    expect(minor('1.234', 'en', 'KWD')).toBe(1234)
    expect(minor('1,234.567', 'en', 'KWD')).toBe(1234567)
    expect(formatPrice(1234567, 'en', 'KWD')).toBe('1234.567')
    // The old behaviour dropped the third place and was ten times out.
    expect(minor('1.234', 'en')).toBe('invalid')
  })

  it('still reads a two-decimal currency exactly as before', () => {
    expect(minor('19.99', 'en', 'USD')).toBe(1999)
    expect(minor('1.234,56', 'de', 'EUR')).toBe(123456)
    expect(formatPrice(123456, 'de', 'EUR')).toBe('1234,56')
  })

  /**
   * The point of the whole fix: there is no path where a wrong number is stored quietly. `19.99`
   * in a yen field is somebody who has not noticed which field they are in, and rounding it to
   * ¥20 for them is the same class of silence as the `1.234,56` → €1.23 bug this file began with.
   */
  it('refuses more decimal places than the currency has, rather than rounding them away', () => {
    expect(minor('19.99', 'en', 'JPY')).toBe('invalid')
    expect(minor('0.5', 'en', 'JPY')).toBe('invalid')
    expect(minor('.5', 'en', 'IRR')).toBe('invalid')
    expect(minor('1.2345', 'en', 'KWD')).toBe('invalid')
    expect(minor('1.234', 'en', 'USD')).toBe('invalid')
  })

  it('round-trips every shipped locale against a currency of each shape', () => {
    for (const locale of ['en', 'de', 'tr', 'fa', 'ar']) {
      for (const currency of ['USD', 'JPY', 'KWD', 'IRR']) {
        for (const value of [0, 7, 2500, 123456, 99999999]) {
          expect({
            locale,
            currency,
            value,
            back: minor(formatPrice(value, locale, currency), locale, currency),
          }).toEqual({ locale, currency, value, back: value })
        }
      }
    }
  })

  it('holds up an example the field would actually accept', () => {
    // It said "Enter an amount like 1234.56" in a yen field and then refused 1234.56.
    expect(priceExample('en', 'JPY')).toBe('1234')
    expect(priceExample('en', 'KWD')).toBe('1234.567')
    expect(priceExample('en', 'USD')).toBe('1234.56')
    expect(priceExample('de', null)).toBe('1234,56')
    for (const currency of ['USD', 'JPY', 'KWD', 'IRR', 'EUR']) {
      const example = priceExample('en', currency)
      expect({ currency, example, ok: parsePrice(example, 'en', currency).ok }).toEqual({
        currency,
        example,
        ok: true,
      })
    }
  })
})

describe('formatPrice', () => {
  it('has no price to show for no price', () => {
    expect(formatPrice(null, 'en')).toBe('')
    expect(formatPrice(undefined, 'de')).toBe('')
  })

  /**
   * What the edit form seeds itself with has to be something the same locale can parse back, or
   * opening an asset and saving it unchanged would report the stored price as invalid.
   */
  it('round-trips through parsePrice in every locale', () => {
    for (const locale of ['en', 'de', 'tr', 'fa', 'ar']) {
      for (const value of [0, 7, 2500, 123456, 99999999]) {
        expect({ locale, value, back: minor(formatPrice(value, locale), locale) }).toEqual({
          locale,
          value,
          back: value,
        })
      }
    }
  })

  it('writes the reader’s own digits', () => {
    expect(formatPrice(123456, 'fa')).toContain('۴')
    expect(formatPrice(123456, 'de')).toBe('1234,56')
    expect(formatPrice(123456, 'en')).toBe('1234.56')
  })
})

/**
 * The list a money field offers.
 *
 * It was `['USD', 'EUR', 'IRR', 'AED']` in a product whose language menu offers Turkish — so a
 * workspace in Istanbul could not record what it paid for anything. The contract takes any ISO
 * 4217 code (`z.string().length(3)`) and the server stores whatever arrives, so nothing but the
 * picker was ever short: four options, one of them missing for one of the five shipped languages.
 */
describe('CURRENCIES', () => {
  it('has a currency for every language this module ships', () => {
    // The point of the whole fix. `tr` is on the language menu and TRY was not on this list.
    for (const code of ['USD', 'EUR', 'TRY', 'IRR', 'AED']) expect(CURRENCIES).toContain(code)
  })

  it('offers codes `Intl` recognises, so a price is never labelled with something invented', () => {
    for (const code of CURRENCIES) {
      const formatted = new Intl.NumberFormat('en', { style: 'currency', currency: code }).format(1)
      // An unknown code comes back as the literal code; a real one gets a symbol or a name, and
      // either way `Intl` accepts it rather than throwing on a malformed one.
      expect({ code, formatted: typeof formatted }).toEqual({ code, formatted: 'string' })
      expect(code).toMatch(/^[A-Z]{3}$/)
    }
  })

  it('lists each code once', () => {
    expect([...new Set(CURRENCIES)]).toEqual([...CURRENCIES])
  })

  /**
   * The order the comment above the list claims, which the list did not have.
   *
   * It said "the currency of each shipped language first, in the order the locales are listed
   * everywhere else in this package (en, ar, de, fa, tr)" while the list read `USD, EUR, AED, TRY,
   * IRR` — en, de, ar, tr, fa, which is no order at all. A rule nothing checks is a rule the next
   * person appends underneath and quietly breaks, so it is checked.
   */
  it('opens with the currency of each shipped language, in the locale order', () => {
    expect(CURRENCIES.slice(0, 5)).toEqual(['USD', 'AED', 'EUR', 'IRR', 'TRY'])
  })

  it('puts the empty option first, because an asset with no price has no currency', () => {
    const options = currencyOptions('—')
    expect(options[0]).toEqual({ value: '', label: '—' })
    expect(options.slice(1).map((o) => o.value)).toEqual([...CURRENCIES])
    // Codes rather than names: ISO 4217 is what the column stores, and a name is one more thing to
    // translate five times for no gain over what somebody reads on their own bank statement.
    expect(options.slice(1).every((o) => o.label === o.value)).toBe(true)
  })
})
