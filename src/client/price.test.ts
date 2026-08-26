import { describe, expect, it } from 'vitest'
import { formatPrice, parsePrice } from './price.js'

/**
 * The regression this file exists for.
 *
 * `raw.replace(',', '.')` replaced the first comma only, so `1.234,56` — how German, Turkish and
 * Persian write twelve hundred — parsed as `1.23456` and was stored as €1.23. Three of the five
 * languages this module ships, silently, with no error anywhere. `abc` and `-5` were worse: they
 * came back `null` and the asset saved with no price at all.
 */
const minor = (raw: string, locale: string) => {
  const result = parsePrice(raw, locale)
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
