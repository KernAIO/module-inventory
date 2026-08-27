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

  it('keeps the check that stops a repair coming back before it was sent', async () => {
    const { rows } = await db.query<{ conname: string; convalidated: boolean }>(
      `select conname, convalidated from pg_constraint
        where conrelid = 'mod_inventory.repairs'::regclass
          and conname = 'inventory_repairs_returned_after_sent'`,
    )
    // Exactly one: `add constraint` is not idempotent on its own, so a replay without the preceding
    // `drop constraint if exists` would either throw or leave two.
    expect(rows).toHaveLength(1)
    /**
     * `not valid`, and asserted rather than assumed.
     *
     * The constraint is enforced on every insert and update from the moment it exists; what
     * `not valid` skips is the scan of rows already in the table — which are exactly the rows this
     * defect may have written. A validating constraint that met one of them would throw *during
     * migration*, and a module's migrations are the first thing the kernel runs, so that is not a
     * broken feature but a host service that never binds its port.
     */
    expect(rows[0]?.convalidated, 'a validating check would fail the upgrade on a row it found').toBe(false)
  })

  it('lets a session with no workspace read the registry the sweeps enumerate', async () => {
    /**
     * The one table in this schema that a scheduler reads unbound.
     *
     * Every table here carries `force row level security`, which subjects the schema's **owner** to
     * its policies as well — so the per-workspace policy alone left `select … from workspaces` with
     * no `app.workspace_id` answering zero rows for everybody but a superuser. That is silent: both
     * nightly sweeps simply found nothing to do. The second policy is what admits the scheduler, and
     * `inventory.int.test.ts` proves it against a plain login role; this proves it survives a replay.
     */
    const { rows } = await db.query<{ policyname: string; cmd: string }>(
      `select policyname, cmd from pg_policies
        where schemaname = 'mod_inventory' and tablename = 'workspaces'
        order by policyname`,
    )
    expect(rows.map((r) => `${r.policyname}:${r.cmd}`)).toEqual([
      'workspaces_unbound_read:SELECT',
      'workspaces_ws_isolation:ALL',
    ])
  })

  /**
   * The timeline's ordering key, which a replay must neither duplicate nor rewind.
   *
   * `asset_history` was read newest-first by its uuidv7 primary key, and a uuidv7 is only ordered to
   * the millisecond — so two entries written inside one sorted by ten random bytes and a timeline
   * could show a file being removed before it was added. `0007` adds a sequence, and the three things
   * that make it work are all things a hand-written migration can get wrong twice: the column has to
   * carry the sequence as its **default** (or the previous image's inserts write nothing into it), the
   * replay must not create a second sequence, and the `setval` must never move the sequence
   * *backwards* onto a value some open transaction has already taken.
   */
  it('gives the timeline a sequence to order by, once', async () => {
    const { rows: columns } = await db.query<{ is_nullable: string; column_default: string | null }>(
      `select is_nullable, column_default from information_schema.columns
        where table_schema = 'mod_inventory' and table_name = 'asset_history' and column_name = 'seq'`,
    )
    expect(columns, 'the column exists after the replay').toHaveLength(1)
    // `not null` **with a default** is what keeps the previous image writing: it never names `seq`,
    // so the default fills it, and it never selects it, so it reads the table exactly as before.
    expect(columns[0]?.is_nullable).toBe('NO')
    expect(columns[0]?.column_default).toContain('asset_history_seq')

    const { rows: sequences } = await db.query<{ n: string }>(
      `select count(*) as n from pg_sequences
        where schemaname = 'mod_inventory' and sequencename = 'asset_history_seq'`,
    )
    expect(Number(sequences[0]?.n), 'a replay must not leave two').toBe(1)

    const { rows: index } = await db.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'mod_inventory' and indexname = 'inventory_asset_history_ws_asset_seq_uq'`,
    )
    expect(index).toHaveLength(1)
    // What the timeline pages on: one asset's entries, bounded by `seq`.
    expect(index[0]?.indexdef).toContain('UNIQUE')
    expect(index[0]?.indexdef).toMatch(/workspace_id.*asset_id.*seq/s)
  })

  it('hands out increasing sequence values to rows written in the same instant', async () => {
    // The property the whole migration exists for, asserted against the schema it produced rather
    // than against the service: three rows in one statement share `created_at` exactly, because it
    // defaults to the transaction's `now()`, and they still come back in an order.
    const workspaceId = '00000000-0000-4000-8000-0000000000aa'
    const assetId = '00000000-0000-4000-8000-0000000000bb'
    await db.query(
      `insert into mod_inventory.asset_history (workspace_id, asset_id, action)
       values ($1,$2,'one'), ($1,$2,'two'), ($1,$2,'three')`,
      [workspaceId, assetId],
    )
    const { rows } = await db.query<{ action: string; seq: string; created_at: Date }>(
      `select action, seq, created_at from mod_inventory.asset_history
        where asset_id = $1 order by seq`,
      [assetId],
    )
    expect(rows.map((r) => r.action)).toEqual(['one', 'two', 'three'])
    expect(new Set(rows.map((r) => r.created_at.toISOString())).size, 'one now()').toBe(1)
    expect(new Set(rows.map((r) => r.seq)).size, 'three distinct sequence values').toBe(3)
  })

  it('keeps the partial index that makes two open repairs impossible', async () => {
    // drizzle emits a bare `CREATE UNIQUE INDEX` for this one; the `if not exists` is added by
    // hand in `0003_repairs.sql`, and a replay is the only thing that proves it is really there.
    const { rows } = await db.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'mod_inventory' and indexname = 'inventory_repairs_one_open_uq'`,
    )
    expect(rows).toHaveLength(1)
    // Partial, not total: an asset may be repaired many times, just not twice at once.
    expect(rows[0]?.indexdef).toContain('WHERE (returned_on IS NULL)')
  })
})
