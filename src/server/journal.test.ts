import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The journal's `when` values must increase with the order the files are applied in.
 *
 * Drizzle's migrator reads the highest `created_at` already in `__migrations` **once**, before the
 * loop, and then applies every journal entry whose `when` is greater than it. It does not re-read
 * that value as it goes, and it does not compare per file. So an entry whose `when` is lower than
 * one already applied is not "applied late" — it is skipped, permanently, with no error.
 *
 * This test is copied from `module-hr`, where `0009_beyond_cap_minutes` was written with a `when`
 * about a day below `0007_hot_path_indexes` and would never have reached a deployed instance. This
 * module has not had that failure, but it has the habit that causes it: `0006`–`0008` were written
 * by hand rather than generated, so their `when` values were typed in — one millisecond apart,
 * counting up from `0005` — and `0009` was the first generated entry after them. Every hand-typed
 * timestamp is a chance to type one that sits below its predecessor, and this is the only thing
 * that would notice.
 *
 * **Nothing else could catch it.** `migrations.test.ts` applies the folder file by file against a
 * scratch database, which is the right way to test that the SQL is idempotent and the wrong way to
 * notice this: it never consults the journal. And a fresh database is fine either way, because with
 * an empty `__migrations` there is no floor to fall below — so a developer's machine, CI, and every
 * new install all agree that everything is well, and only an existing deployment is missing a
 * column. That combination is why this is a test about a JSON file rather than about SQL.
 */
describe('the migration journal', () => {
  const journal = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../migrations/meta/_journal.json', import.meta.url)), 'utf8'),
  ) as { entries: Array<{ idx: number; when: number; tag: string }> }

  it('has entries in the order they are applied', () => {
    const entries = journal.entries
    expect(entries.length).toBeGreaterThan(0)
    for (let i = 1; i < entries.length; i++)
      expect(
        entries[i]!.idx,
        `${entries[i]!.tag} is listed before ${entries[i - 1]!.tag}; the journal array is the apply order`,
      ).toBeGreaterThan(entries[i - 1]!.idx)
  })

  it('never lets a later migration carry an earlier timestamp', () => {
    let highest = Number.NEGATIVE_INFINITY
    let highestTag = '(none)'
    for (const entry of journal.entries) {
      expect(
        entry.when,
        `${entry.tag} has when=${entry.when}, which is below ${highestTag}'s ${highest}. ` +
          'Drizzle compares each entry against the highest timestamp already applied, so this file ' +
          'would be skipped on every database that has reached that one — silently, and only on ' +
          'databases that already exist. Raise it above the entry before it.',
      ).toBeGreaterThan(highest)
      highest = entry.when
      highestTag = entry.tag
    }
  })
})
