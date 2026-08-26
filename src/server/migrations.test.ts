import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_TABLES } from './schema.js'

/**
 * The migration folder, applied to a database created from nothing — and then applied again.
 *
 * The integration suite already proves the folder *applies*, because `kernel.start()` runs it. It
 * does not prove the folder is **replayable**, and that is the property that took `core` down: the
 * kernel migrates every module at boot, so one migration that throws does not degrade its own
 * feature — `core` hosts five modules and never binds its port. A regenerated
 * `migrations/meta/_journal.json` is enough to cause a replay, because every entry gets a `when`
 * newer than the rows already in `mod_inventory.__migrations`.
 *
 * Three things here are deliberate, and each of them is a way this test could have been vacuously
 * green instead:
 *
 * 1. **A scratch database, created here.** Running against a database somebody has already migrated
 *    proves nothing — it is the same shape of mistake as asserting that `migrateModule` succeeds
 *    twice against a schema that already exists.
 * 2. **Every statement is executed separately and every failure is collected**, rather than throwing
 *    on the first. Guarding one class of statement and re-running tells you only about the next one;
 *    collecting them says how much is actually unguarded. In `module-hr` that difference was 203
 *    statements hiding behind the policies somebody had just fixed.
 * 3. **Policies are asserted as `(tablename, policyname)` pairs, not as a count per table.** "One
 *    policy per table" is the wrong invariant — a table may legitimately carry several — and a
 *    duplicate pair is exactly what a replay produces.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = join(HERE, '../../migrations')

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB_NAME = `kern_inventory_replay_${Date.now().toString(36)}`

let admin: pg.Client
let db: pg.Client

/** The folder in the order the kernel applies it — by filename, which is why they are numbered. */
function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

/**
 * Apply one file statement by statement, returning every failure rather than the first.
 *
 * `--> statement-breakpoint` is drizzle's separator. Splitting on it is also why nothing in this
 * folder may use a dollar-quoted body: a breakpoint inside `do $$ … end $$` cuts the function in
 * half, and the error is `unterminated dollar-quoted string`, which does not sound like what it is.
 */
async function apply(file: string): Promise<Array<{ statement: string; error: string }>> {
  const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
  const failures: Array<{ statement: string; error: string }> = []
  for (const raw of sql.split('--> statement-breakpoint')) {
    const statement = raw.trim()
    if (!statement || statement.split('\n').every((l) => l.trim().startsWith('--'))) continue
    try {
      await db.query(statement)
    } catch (err) {
      failures.push({
        statement: statement.slice(0, 120).replace(/\s+/g, ' '),
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return failures
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB_NAME}"`)
  const url = new URL(BASE_URL)
  url.pathname = `/${DB_NAME}`
  db = new pg.Client({ connectionString: url.toString() })
  await db.connect()
}, 120_000)

afterAll(async () => {
  await db?.end().catch(() => undefined)
  await admin?.query(`drop database if exists "${DB_NAME}" with (force)`).catch(() => undefined)
  await admin?.end().catch(() => undefined)
})

describe('the migration folder', () => {
  it('applies to a database created from nothing', async () => {
    for (const file of migrationFiles()) {
      expect(await apply(file), `${file}, first pass`).toEqual([])
    }
  })

  it('applies a second time, because a replay must not take down the host service', async () => {
    for (const file of migrationFiles()) {
      expect(await apply(file), `${file}, replay`).toEqual([])
    }
  })

  it('leaves exactly one of every policy after the replay', async () => {
    const { rows } = await db.query<{ tablename: string; policyname: string }>(
      `select tablename, policyname from pg_policies where schemaname = 'mod_inventory'`,
    )
    const seen = rows.map((r) => `${r.tablename}.${r.policyname}`)
    expect([...new Set(seen)].sort(), 'a duplicate pair is what a replay produces').toEqual(seen.sort())
    // And the policies are the ones the module declares it has.
    for (const table of TENANT_TABLES)
      expect(seen, `mod_inventory.${table} has its policy`).toContain(`${table}.${table}_ws_isolation`)
  })

  it('forces row-level security on every table that carries a policy', async () => {
    // Restricted to tables that have one: a module may legitimately keep an unsecured table, and
    // asserting over every table in the schema would fail on drizzle's own `__migrations`.
    const { rows } = await db.query<{ relname: string; forced: boolean }>(
      `select c.relname, c.relforcerowsecurity as forced
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'mod_inventory'
          and c.relkind = 'r'
          and exists (select 1 from pg_policies p
                       where p.schemaname = 'mod_inventory' and p.tablename = c.relname)`,
    )
    expect(rows.length, 'no policies found at all — the RLS migration did not run').toBeGreaterThan(0)
    for (const row of rows) expect(row.forced, `mod_inventory.${row.relname} forces RLS`).toBe(true)
  })

  it('keeps the exclusion constraint that makes two open custody periods impossible', async () => {
    const { rows } = await db.query<{ n: string }>(
      `select count(*) as n from pg_constraint where conname = 'inventory_custody_no_overlap'`,
    )
    // Exactly one: `add constraint` is not idempotent on its own, so a replay without the
    // preceding `drop constraint if exists` would either throw or leave two.
    expect(Number(rows[0]?.n)).toBe(1)
  })
})
