import { describe, expect, it } from 'vitest'
import { ar, de, en, fa, inventoryMessageBundles, tr } from './messages.js'

/**
 * The bundles, structurally — and the counted messages, behaviourally.
 *
 * Nothing else looks at these. A key present in English and missing in Persian type-checks, builds,
 * lints and ships, and the first person to see it is the one reading `inventory.status_lost` on a
 * screen. Adding a status to `AssetStatus` and forgetting four translations is the exact shape of
 * that mistake, and this file is what makes it fail here instead.
 */
const BUNDLES = { en, ar, de, fa, tr } as const
type Locale = keyof typeof BUNDLES

/** The count placeholder: the runtime accepts `count` or `n`, and this module's catalogue uses `n`. */
const COUNT = 'n'
const placeholders = (s: string) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))
const forms = (v: unknown): string[] => (typeof v === 'string' ? [v] : Object.values(v as object))

describe('bundles', () => {
  it('declares every locale the module claims to ship', () => {
    expect(Object.keys(inventoryMessageBundles).sort()).toEqual(['ar', 'de', 'en', 'fa', 'tr'])
  })

  it('has the same key set in every locale', () => {
    const keys = Object.keys(en).sort()
    for (const [locale, bundle] of Object.entries(BUNDLES)) {
      expect({ locale, keys: Object.keys(bundle).sort() }).toEqual({ locale, keys })
    }
  })

  it('namespaces every key, so two modules cannot collide in the merged map', () => {
    for (const key of Object.keys(en)) expect(key.startsWith('inventory.')).toBe(true)
  })

  /**
   * A plural form may drop the numeral — "one asset" reads better than "1 asset" in some
   * languages — but dropping any *other* placeholder loses information the sentence needed.
   */
  it('keeps every non-count placeholder in every plural form', () => {
    for (const [key, value] of Object.entries(en)) {
      const expected = placeholders(forms(value).join(' '))
      expected.delete(COUNT)
      for (const [locale, bundle] of Object.entries(BUNDLES)) {
        for (const form of forms(bundle[key as keyof typeof bundle])) {
          const got = placeholders(form)
          got.delete(COUNT)
          expect({ key, locale, form, got: [...got].sort() }).toEqual({
            key,
            locale,
            form,
            got: [...expected].sort(),
          })
        }
      }
    }
  })

  it('never invents a placeholder the English string does not have', () => {
    for (const [key, value] of Object.entries(en)) {
      const allowed = placeholders(forms(value).join(' '))
      for (const [locale, bundle] of Object.entries(BUNDLES))
        for (const form of forms(bundle[key as keyof typeof bundle]))
          for (const name of placeholders(form))
            expect({ key, locale, name, known: allowed.has(name) }).toEqual({
              key,
              locale,
              name,
              known: true,
            })
    }
  })

  /** Arabic inflects six ways. A bundle with only one/other picks `other` for two, and reads wrong. */
  it('gives every Arabic plural all six CLDR categories', () => {
    const wanted = new Intl.PluralRules('ar').resolvedOptions().pluralCategories.sort()
    for (const [key, value] of Object.entries(ar)) {
      if (typeof value === 'string') continue
      expect({ key, cats: Object.keys(value).sort() }).toEqual({ key, cats: wanted })
    }
  })

  it('makes a plural of a key wherever English has one', () => {
    for (const [key, value] of Object.entries(en)) {
      if (typeof value === 'string') continue
      for (const [locale, bundle] of Object.entries(BUNDLES))
        expect({ key, locale, plural: typeof bundle[key as keyof typeof bundle] }).toEqual({
          key,
          locale,
          plural: 'object',
        })
    }
  })
})

/**
 * Every status the contract can hold has a label, in every language.
 *
 * The screens render a status with `t(`status_${status}`)`, which cannot be type-checked: a status
 * added to the enum and not to the catalogue renders the literal key `inventory.status_lost` in the
 * middle of a table, in every locale at once.
 */
describe('status labels', () => {
  // Not imported from the contract: this file is data-only on purpose, and a copy of six strings
  // that must match is exactly what a test is for.
  const STATUSES = ['in_stock', 'assigned', 'reserved', 'under_repair', 'lost', 'retired']

  it('labels every asset status in every locale', () => {
    for (const status of STATUSES)
      for (const [locale, bundle] of Object.entries(BUNDLES))
        expect({ status, locale, has: `inventory.status_${status}` in bundle }).toEqual({
          status,
          locale,
          has: true,
        })
  })
})

/**
 * The counted messages, resolved the way the runtime resolves them.
 *
 * `t()` lives in `@kernhq/ui`, whose entry point pulls in Svelte components this package's test
 * setup cannot transform. So these drive the *data* through the same `Intl.PluralRules` selection
 * `selectPlural` performs, and `t()` itself is tested where it lives.
 */
describe('counted messages', () => {
  const pick = (locale: Locale, key: string, count: number): string => {
    const value = BUNDLES[locale][key as keyof (typeof BUNDLES)[Locale]] as
      | string
      | Partial<Record<Intl.LDMLPluralRule, string>>
    if (typeof value === 'string') return value
    const category = new Intl.PluralRules(locale).select(count)
    const form = value[category] ?? value.other
    if (form === undefined) throw new Error(`${locale} ${key} has no form for ${count}`)
    return form.replace(/\{n\}/g, new Intl.NumberFormat(locale).format(count))
  }

  it('says "1 asset" and "2 assets" in English', () => {
    expect(pick('en', 'inventory.count', 1)).toBe('1 asset')
    expect(pick('en', 'inventory.count', 2)).toBe('2 assets')
  })

  it('says "1 Gegenstand" and "2 Gegenstände" in German', () => {
    expect(pick('de', 'inventory.count', 1)).toBe('1 Gegenstand')
    expect(pick('de', 'inventory.count', 2)).toBe('2 Gegenstände')
  })

  it('follows Arabic numeral agreement rather than one-or-many', () => {
    expect(pick('ar', 'inventory.count', 0)).toBe('لا أصول')
    expect(pick('ar', 'inventory.count', 1)).toBe('أصل واحد')
    expect(pick('ar', 'inventory.count', 2)).toBe('أصلان')
    expect(pick('ar', 'inventory.count', 5)).toContain('أصول')
  })

  it('does not inflect the noun after a numeral in Turkish or Persian', () => {
    // "5 demirbaş", not "5 demirbaşlar" — the plural suffix is wrong once a number is present.
    expect(pick('tr', 'inventory.count', 1).replace('1', '')).toBe(
      pick('tr', 'inventory.count', 5).replace('5', ''),
    )
    expect(pick('fa', 'inventory.count', 1).replace('۱', '')).toBe(
      pick('fa', 'inventory.count', 5).replace('۵', ''),
    )
  })

  it('formats the number in the reader’s own digits', () => {
    expect(pick('fa', 'inventory.count', 5)).toContain('۵')
    expect(pick('en', 'inventory.count', 5)).toContain('5')
  })
})
