import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

  /**
   * The slip that six forms invite: writing five of them and abbreviating the sixth.
   *
   * `many` is the form for 11–99, where Arabic puts the counted noun in the singular accusative —
   * "{n} أصلاً". Because that form is written *differently* from `other`, it gets written from
   * scratch rather than copied, and a compound noun loses half of itself on the way: the shell's
   * `modules_meta_objects` said "{n} نوعاً" — "{n} type" — where every other form said "نوع كائن",
   * "object type". Nothing catches that. It compiles, it has all six categories, it has the right
   * placeholder, and it is missing the word the sentence is about.
   *
   * Word count against `other` is a heuristic and is named as one: a form with *fewer* words than
   * `other` has dropped one, and in a counted phrase the word it drops is the noun. Inflection
   * changes a word's letters, not how many words there are, so this stays true across all six.
   */
  it('never drops a word from an Arabic plural form that the `other` form has', () => {
    const words = (form: string) => form.split(/\s+/).filter((word) => word && !word.includes('{')).length
    for (const [key, value] of Object.entries(ar)) {
      if (typeof value === 'string') continue
      const other = (value as Record<string, string>).other ?? ''
      for (const [category, form] of Object.entries(value as Record<string, string>)) {
        // `zero` is a negation — "لا أصول" — and is the one form entitled to a different shape.
        if (category === 'zero') continue
        expect({ key, category, form, atLeast: words(other) }).toEqual({
          key,
          category,
          form,
          atLeast: Math.min(words(form), words(other)),
        })
      }
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

// ------------------------------------------------------ keys nothing asks for any more

const HERE = dirname(fileURLToPath(import.meta.url))

/** Everything in this client that could name a key — components included, catalogue excluded. */
function clientSource(): string {
  const files = readdirSync(HERE, { recursive: true, encoding: 'utf8' }).filter(
    (file) =>
      (file.endsWith('.ts') || file.endsWith('.svelte')) &&
      !file.endsWith('.test.ts') &&
      !file.endsWith('messages.ts'),
  )
  return files.map((file) => readFileSync(join(HERE, file), 'utf8')).join('\n')
}

/**
 * The two families of key that are *built* rather than written, and so are never literals.
 *
 * `t(`status_${status}`)` and `actionKey()`'s `history_${action}`. Both lists are duplicated here
 * on purpose — the file is data-only and importing the contract to check a catalogue would be a
 * circular sort of proof — and `status labels` below already holds the first one to the contract.
 */
const BUILT = new Set([
  ...['in_stock', 'assigned', 'reserved', 'under_repair', 'lost', 'retired'].map((s) => `status_${s}`),
  ...[
    'created',
    'updated',
    'assigned',
    'transferred',
    'returned',
    'archived',
    'restored',
    'lost',
    'written_off',
    'reinstated',
    'repair_logged',
    'repair_completed',
    'attachment_added',
    'attachment_removed',
  ].map((a) => `history_${a}`),
  // The label for a field's type, `t(`field_type_${type}`)`, on the fields settings page.
  ...['text', 'number', 'date', 'select', 'multiselect', 'checkbox', 'url'].map((f) => `field_type_${f}`),
])

describe('every key is one something asks for', () => {
  /**
   * `inventory.settings_save_error` — "The settings could not be saved" — sat in all five bundles
   * with nothing reading it: the save bar renders `errorMessage(err, t)`, which names the actual
   * refusal instead. A dead key is five translations somebody maintains, reviews and re-reads for
   * a sentence that cannot appear, and nothing about it looks wrong from inside the catalogue.
   *
   * Literals rather than a runtime trace, because a `.svelte` file cannot be unit-tested here —
   * the same reason `errors.test.ts` reads `src/server` off disk. It misses a key that happens to
   * appear as an unrelated string somewhere, which is a false *pass*; it never fails a key that is
   * really used, which is the direction that matters for a check nobody wants to fight.
   */
  it('has nothing in the catalogue that no screen can reach', () => {
    const source = clientSource()
    const dead = Object.keys(en)
      .map((key) => key.slice('inventory.'.length))
      .filter((name) => !BUILT.has(name))
      .filter((name) => !(source.includes(`'${name}'`) || source.includes(`"${name}"`)))
    expect(dead).toEqual([])
  })

  it('is reading the client rather than passing on an empty sweep', () => {
    expect(clientSource().length).toBeGreaterThan(10_000)
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

/**
 * One word per idea, across the whole product and not just across this module.
 *
 * A module is read beside the shell, so a second Turkish word for un-archiving something is a
 * product that says two things for one action. `ws_archive_hint` and `ws_archive_confirm_body` in
 * `shell/messages/tr.json` both say **geri getir** about an archived workspace; this bundle said
 * *geri yükle*, three lines away from "Daha fazla yükle" (load more) and "sayfayı yeniden yükleyin"
 * (reload) — one verb doing three jobs in one panel.
 *
 * Pinned here because it cannot be checked against the shell: a module is built standalone, and
 * `shell/messages/*.json` is not in this package. The word is the decision; the test is the memory.
 */
describe('the words Kern already uses', () => {
  it('un-archives with the shell’s own Turkish verb, and never overloads “yükle”', () => {
    expect(tr['inventory.restore']).toBe('Geri getir')
    const overloaded = Object.entries(tr)
      .filter(([, value]) => typeof value === 'string' && (value as string).includes('geri yükle'))
      .map(([key]) => key)
    expect(overloaded).toEqual([])
  })

  /** «إعادة التحميل» is what the shell calls Reload (`pwa_update_reload`), so a reload says that. */
  it('reloads with the shell’s own words in Arabic', () => {
    expect(ar['inventory.error_conflict']).toContain('أعد تحميل الصفحة')
  })
})
