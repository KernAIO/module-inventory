import { randomUUID } from 'node:crypto'
import { Cursor, type Principal, type WorkspaceId } from '@kernhq/contracts'
import { createKernel, type Kernel, type RequestContext, type Tx } from '@kernhq/kernel'
import { call } from '@orpc/server'
import { and, asc, eq } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Asset } from '../contract/models.js'
import { inventoryModule } from './index.js'
import { inventoryRouter } from './router.js'
import { assetHistory, assets, custodyPeriods, TENANT_TABLES } from './schema.js'

/**
 * Inventory against a real Postgres.
 *
 * The unit tests walk the contract and the router as data; this proves the things only a database
 * can answer — that both migrations apply on a database created from nothing, that the exclusion
 * constraint refuses the write it claims to, that row-level security holds for a role that cannot
 * bypass it, and that the keyset cursor pages through a list without dropping or repeating a row.
 *
 * A scratch database per run, dropped afterwards, so it never touches development data.
 */

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB_NAME = `kern_inventory_test_${Date.now().toString(36)}`
const RLS_ROLE = `kern_inv_rls_${Date.now().toString(36)}`

let kernel: Kernel
let inv: ReturnType<typeof inventoryRouter>
let admin: pg.Client
let databaseUrl: string

/** Branded in the contract, plain uuids here — the brand is a compile-time claim, not a value. */
const workspace = () => randomUUID() as WorkspaceId

const WS_A = workspace()
const WS_B = workspace()
/** Its own workspace, so the counter starts at 1 and the codes are predictable. */
const WS_CODES = workspace()
const WS_PAGE = workspace()
const WS_FILTER = workspace()

const ALICE = randomUUID()
const BOB = randomUUID()

const principal = (userId: string, workspaceId: string): Principal =>
  // `unknown` first: `userId` is branded on Principal and a plain string does not overlap it, which
  // is a real difference the test does not need to model.
  ({
    kind: 'user',
    userId,
    email: `${userId}@example.test`,
    name: userId.slice(0, 8),
    locale: 'en',
    instanceAdmin: false,
    service: null,
    memberships: [{ workspaceId, role: 'admin', roleIds: [], groupIds: [], status: 'active' }],
    permissionVersion: 0,
  }) as unknown as Principal

const inWs =
  (workspaceId: string) =>
  <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    kernel.database.withWorkspace(workspaceId, fn, { userId: ALICE })

const run = inWs(WS_A)

function registerCoreStubs(k: Kernel) {
  k.broker.register('core', {
    'activity.record': { handler: async () => ({ ok: true }) },
    'notifications.create': { handler: async () => ({ ok: true }) },
    'search.index': { handler: async () => ({ ok: true }) },
    'search.remove': { handler: async () => ({ ok: true }) },
    'modules.isEnabled': { handler: async () => true },
    'authz.customRolePermissions': { handler: async () => [] },
    'authz.bindings': { handler: async () => [] },
    // Inventory declares one capability, `core`, and it is `required` — so nothing here has to
    // switch anything on. Empty settings is what a workspace that never opened the module has, and
    // `InventorySettings` fills in `INV-`/4 from its own defaults.
    'settings.getModule': { handler: async () => ({}) },
    'settings.setModule': { handler: async () => ({ ok: true }) },
  })
}

/**
 * A request context, as the HTTP layer would build one.
 *
 * Every procedure is called through `call()` rather than through its service, because the router is
 * the only place `workspaceScoped` and `requires` live — calling `AssetService` directly would test
 * the query and skip the two gates that decide whether anybody may reach it.
 */
const asUser = (userId: string, workspaceId: string = WS_A): RequestContext => ({
  kernel,
  principal: principal(userId, workspaceId),
  requestId: randomUUID(),
  ip: '127.0.0.1',
  headers: {},
})

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB_NAME}"`)
  const url = new URL(BASE_URL)
  url.pathname = `/${DB_NAME}`
  databaseUrl = url.toString()

  kernel = await createKernel({
    service: 'inventory-test',
    modules: [inventoryModule],
    role: 'api',
    env: {
      DATABASE_URL: databaseUrl,
      KERN_SECRET: 'test-secret-that-is-long-enough-for-kern',
      NODE_ENV: 'test',
      NATS_URL: undefined,
      VALKEY_URL: undefined,
    },
  })
  registerCoreStubs(kernel)
  await kernel.start()
  inv = inventoryRouter(kernel)
}, 180_000)

afterAll(async () => {
  await kernel?.stop().catch(() => undefined)
  await admin.query(`drop database if exists "${DB_NAME}" with (force)`).catch(() => undefined)
  await admin.query(`drop role if exists "${RLS_ROLE}"`).catch(() => undefined)
  await admin.end().catch(() => undefined)
})

// ---------------------------------------------------------------------------------------------
// helpers

interface NewAsset {
  name: string
  description?: string
  serialNumber?: string | null
  location?: string | null
  purchasedOn?: string | null
  priceMinor?: number | null
  currency?: string | null
}

const createAsset = (workspaceId: WorkspaceId, input: NewAsset, userId = ALICE): Promise<Asset> =>
  call(inv.assets.create, { workspaceId, ...input }, { context: asUser(userId, workspaceId) })

const listAssets = (
  workspaceId: WorkspaceId,
  input: Omit<Parameters<typeof inv.assets.list>[0], 'workspaceId'> = {},
  userId = ALICE,
) => call(inv.assets.list, { workspaceId, ...input }, { context: asUser(userId, workspaceId) })

/**
 * The error a rejected call actually carried.
 *
 * `KernError` travels up through `call()` unwrapped, but oRPC is free to wrap it, so this reaches
 * through `cause` rather than trusting the top frame. Asserting on the message would pass for any
 * failure — a typo in the input included — which is the whole thing these tests are trying to rule
 * out.
 */
async function refusedWith(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (err) {
    let cursor: unknown = err
    for (let depth = 0; depth < 5 && cursor; depth++) {
      const code = (cursor as { code?: unknown }).code
      if (typeof code === 'string') return code
      cursor = (cursor as { cause?: unknown }).cause
    }
    throw new Error(`Rejected, but with no error code: ${String(err)}`)
  }
  throw new Error('Expected the call to be refused, but it succeeded')
}

/**
 * Postgres reports which constraint refused a write; drizzle wraps that in a "Failed query" error
 * whose message does not carry the name. Asserting on the message alone would pass for *any*
 * failure, so this reaches through to the driver's own field.
 */
async function constraintViolated(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (err) {
    let cursor: unknown = err
    for (let depth = 0; depth < 5 && cursor; depth++) {
      const name = (cursor as { constraint?: string }).constraint
      if (name) return name
      cursor = (cursor as { cause?: unknown }).cause
    }
    throw new Error(`Rejected, but not by a named constraint: ${String(err)}`)
  }
  throw new Error('Expected the write to be refused, but it succeeded')
}

// ---------------------------------------------------------------------------------------------

/**
 * Booting the module is itself the first assertion: `kernel.start()` creates `mod_inventory` and
 * runs both migrations, so a broken one fails here rather than on somebody's instance during an
 * upgrade. Two of them have already shipped broken — a `gist` exclusion constraint with no
 * `btree_gist`, and two column-level primary keys — and each one stops the *host service* booting,
 * not merely this module.
 */
describe('the module boots', () => {
  it('created its schema and every table it declares', async () => {
    const { rows } = await kernel.database.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'mod_inventory' order by 1`,
    )
    const names = rows.map((r) => r.table_name)
    for (const t of TENANT_TABLES) expect(names, `mod_inventory.${t}`).toContain(t)
  })

  it('put row-level security on every tenant table', async () => {
    const { rows } = await kernel.database.pool.query<{ tablename: string; rowsecurity: boolean }>(
      `select tablename, rowsecurity from pg_tables where schemaname = 'mod_inventory'`,
    )
    const secured = new Map(rows.map((r) => [r.tablename, r.rowsecurity]))
    // Checked against TENANT_TABLES rather than "every table in the schema": drizzle's own
    // `__migrations` bookkeeping lives here too and is not tenant data. Asserting over the declared
    // list is also what makes a new table added without a policy fail — the whole reason the list
    // exists next to the schema.
    for (const t of TENANT_TABLES) expect(secured.get(t), `mod_inventory.${t} has RLS`).toBe(true)
  })

  it('leaves no table carrying workspace_id out of TENANT_TABLES', async () => {
    /**
     * Guards the other direction, and does it against the **database** rather than a count.
     *
     * A table added to `schema.ts` but left out of `TENANT_TABLES` passes the test above by simply
     * never being asked about — which is exactly how a table ships without a policy. Comparing what
     * actually exists to what is declared cannot go stale, where a hardcoded number goes stale the
     * first time anybody adds a table.
     *
     * "Carries `workspace_id`" is the rule, not "is in the schema", because that is the rule
     * `schema.ts` states at the top of the file: a column named `workspace_id` is the definition of
     * a tenant table, and a tenant table without a policy is simply readable by anything that
     * reaches the database another way.
     */
    const { rows } = await kernel.database.pool.query<{ table_name: string }>(
      `select c.relname as table_name
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a
           on a.attrelid = c.oid
          and a.attname = 'workspace_id'
          and a.attnum > 0
          and not a.attisdropped
        where n.nspname = 'mod_inventory'
          and c.relkind in ('r', 'p')
          and not c.relispartition`,
    )
    const declared = new Set<string>(TENANT_TABLES)
    const undeclared = rows
      .map((r) => r.table_name)
      // drizzle's own bookkeeping is not tenant data and correctly has no policy.
      .filter((t) => !t.startsWith('__'))
      .filter((t) => !declared.has(t))
    expect(undeclared, 'tables carrying workspace_id but missing from TENANT_TABLES').toEqual([])
  })
})

/**
 * The two constraints the schema leans on, checked as facts about the database rather than as
 * intentions in TypeScript.
 */
describe('the schema the migrations actually produced', () => {
  it('gives counters one composite primary key, not two', async () => {
    // The regression test for SQLSTATE 42P16. Two column-level `.primaryKey()` calls read like a
    // compound key and are not one — Postgres refuses the table, and because a module's migration
    // is the first thing the kernel runs the symptom is a host service that never binds its port.
    // By the time the suite gets here the table exists, so what is left to prove is that the key is
    // the pair rather than one column with the other silently dropped.
    const { rows } = await kernel.database.pool.query<{ attname: string }>(
      `select a.attname
         from pg_constraint c
         join unnest(c.conkey) with ordinality as k(attnum, ord) on true
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
        where c.conrelid = 'mod_inventory.counters'::regclass
          and c.contype = 'p'
        order by k.ord`,
    )
    expect(rows.map((r) => r.attname)).toEqual(['workspace_id', 'key'])
  })

  it('installed btree_gist, without which the custody constraint cannot exist', async () => {
    // Core creates pg_trgm, pgcrypto, ltree and vector; btree_gist is not among them. A module
    // reaching for `uuid with =` inside a gist exclusion constraint declares it itself, or its
    // migration dies on a clean database with "data type uuid has no default operator class for
    // access method gist" — invisible on any machine whose database already had the extension.
    const { rows } = await kernel.database.pool.query<{ extname: string }>(
      `select extname from pg_extension where extname = 'btree_gist'`,
    )
    expect(rows.map((r) => r.extname)).toEqual(['btree_gist'])
  })

  it('carries the custody exclusion constraint', async () => {
    const { rows } = await kernel.database.pool.query<{ contype: string }>(
      `select contype from pg_constraint
        where conrelid = 'mod_inventory.custody_periods'::regclass
          and conname = 'inventory_custody_no_overlap'`,
    )
    expect(rows[0]?.contype, "'x' means exclusion").toBe('x')
  })

  it('refuses a second open custody period for the same asset', async () => {
    // The constraint's whole purpose, and the half a schema dump cannot show: two concurrent
    // transfers must not both win. `effective_to` null means "still open", which tstzrange treats
    // as unbounded, so an open period overlaps everything that would follow it.
    const asset = await createAsset(WS_A, { name: 'Contested laptop' })
    await run((tx) =>
      tx.insert(custodyPeriods).values({ workspaceId: WS_A, assetId: asset.id, userId: ALICE }),
    )
    const name = await constraintViolated(() =>
      run((tx) => tx.insert(custodyPeriods).values({ workspaceId: WS_A, assetId: asset.id, userId: BOB })),
    )
    expect(name).toBe('inventory_custody_no_overlap')
  })

  it('still allows an open period once the previous one is closed', async () => {
    // The other half: a constraint that refused this would make a transfer impossible, and a test
    // that only proves rejection cannot tell the two apart.
    const asset = await createAsset(WS_A, { name: 'Handed on' })
    await run((tx) =>
      tx.insert(custodyPeriods).values({
        workspaceId: WS_A,
        assetId: asset.id,
        userId: ALICE,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        effectiveTo: new Date('2026-06-01T00:00:00Z'),
      }),
    )
    await run((tx) =>
      tx.insert(custodyPeriods).values({
        workspaceId: WS_A,
        assetId: asset.id,
        userId: BOB,
        effectiveFrom: new Date('2026-06-01T00:00:00Z'),
      }),
    )
    const rows = await run((tx) =>
      tx.select().from(custodyPeriods).where(eq(custodyPeriods.assetId, asset.id)),
    )
    expect(rows).toHaveLength(2)
  })
})

/**
 * Row-level security, proven as a role that cannot bypass it.
 *
 * The development user is a superuser, and superusers bypass RLS entirely — so the same assertions
 * run as `kern` would pass against a table with no policy at all. This is the only version of the
 * test that proves anything.
 */
describe('row-level security, as a role that cannot bypass it', () => {
  let plain: pg.Client

  beforeAll(async () => {
    await createAsset(WS_A, { name: 'Visible to A' })
    await createAsset(WS_B, { name: 'Visible to B' }, BOB)

    const scratch = new pg.Client({ connectionString: databaseUrl })
    await scratch.connect()
    await scratch.query(`create role "${RLS_ROLE}" login password 'probe'`)
    await scratch.query(`grant usage on schema mod_inventory to "${RLS_ROLE}"`)
    await scratch.query(`grant select on all tables in schema mod_inventory to "${RLS_ROLE}"`)
    await scratch.end()

    const url = new URL(databaseUrl)
    url.username = RLS_ROLE
    url.password = 'probe'
    plain = new pg.Client({ connectionString: url.toString() })
    await plain.connect()
  }, 60_000)

  afterAll(async () => {
    await plain?.end().catch(() => undefined)
  })

  const count = async (sqlText: string) => {
    const { rows } = await plain.query<{ n: string }>(sqlText)
    return Number(rows[0]?.n ?? -1)
  }

  it('shows nothing at all when no workspace is set', async () => {
    await plain.query('reset app.workspace_id')
    expect(await count('select count(*) as n from mod_inventory.assets')).toBe(0)
    expect(await count('select count(*) as n from mod_inventory.asset_history')).toBe(0)
  })

  it('shows one workspace its own rows', async () => {
    await plain.query(`set app.workspace_id = '${WS_A}'`)
    expect(await count('select count(*) as n from mod_inventory.assets')).toBeGreaterThan(0)
  })

  it('shows one workspace nothing of another', async () => {
    await plain.query(`set app.workspace_id = '${WS_B}'`)
    expect(await count(`select count(*) as n from mod_inventory.assets where workspace_id = '${WS_A}'`)).toBe(
      0,
    )
    // And the reverse, so a policy that simply hides everything cannot pass this.
    expect(await count(`select count(*) as n from mod_inventory.assets where workspace_id = '${WS_B}'`)).toBe(
      1,
    )
  })
})

/**
 * The counter row's conflict lock, under the only condition that can break it.
 *
 * `insert … on conflict do update … returning` increments under the row lock the insert already
 * takes, so two concurrent creates each read the value their own statement returned. Run one at a
 * time this is indistinguishable from a read-then-write, which is the version that hands two people
 * the same asset tag.
 */
describe('asset codes under concurrency', () => {
  it('gives twenty simultaneous creates twenty different codes', async () => {
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, i) => createAsset(WS_CODES, { name: `Laptop ${i}` })),
    )
    const codes = created.map((a) => a.code)
    expect(new Set(codes).size, 'every code is distinct').toBe(20)
    for (const code of codes) expect(code).toMatch(/^INV-\d{4}$/)
    // A fresh workspace, so the counter started at 1 and the run is exactly 1..20 — which also
    // catches a lock that let two transactions read the same value and then skip a number.
    expect([...codes].sort()).toEqual(
      Array.from({ length: 20 }, (_, i) => `INV-${String(i + 1).padStart(4, '0')}`),
    )
  })
})

/**
 * Keyset pagination, checked as the property that actually matters: paging through a list must
 * yield every row exactly once. An off-by-one in the cursor comparison repeats the boundary row; a
 * cursor on a non-unique column drops the rows that share its value. Both look like a working list
 * on page one, which is why the page used to filter in the browser and nobody noticed.
 */
describe('paging through a list', () => {
  const TOTAL = 25
  /** Deliberately repeated: `name` is not unique, which is why the cursor carries the id too. */
  const NAMES = ['Chair', 'Desk', 'Laptop', 'Monitor', 'Phone']
  let everyId: string[] = []

  beforeAll(async () => {
    const created: Asset[] = []
    /**
     * Serially **and a clear millisecond apart**, so `recent` (uuidv7 order) really is creation
     * order and a repeated row is visible.
     *
     * The wait is not padding. `uuidv7()` carries the clock in its first six bytes — to the
     * millisecond — and fills the remaining ten from `randomUUID()`, with no counter: two rows
     * created inside one millisecond sort in *random* order relative to each other. Serial creates
     * alone do not buy the ordering this block's assertions rest on, they only make it likely, and
     * anything that makes `create` quicker (taking the module-settings read out of the
     * transaction did) raises the collision rate until the suite fails intermittently on an
     * ordering the module never promised.
     */
    for (let i = 0; i < TOTAL; i++) {
      created.push(await createAsset(WS_PAGE, { name: NAMES[i % NAMES.length]! }))
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    everyId = created.map((a) => a.id)
  }, 120_000)

  async function pageThrough(sort: 'recent' | 'name' | 'code') {
    const seen: Asset[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await listAssets(WS_PAGE, { sort, limit: 10, ...(cursor ? { cursor } : {}) })
      seen.push(...page.items)
      cursor = page.nextCursor ?? undefined
      pages += 1
      if (pages > 10) throw new Error('paging did not terminate')
    } while (cursor)
    return { seen, pages }
  }

  it('returns every row exactly once, newest first', async () => {
    const { seen, pages } = await pageThrough('recent')
    expect(pages, '25 rows at 10 a page').toBe(3)
    expect(seen).toHaveLength(TOTAL)
    expect(new Set(seen.map((a) => a.id)).size, 'no row appears twice').toBe(TOTAL)
    expect([...seen.map((a) => a.id)].sort()).toEqual([...everyId].sort())
    expect(seen.map((a) => a.id)).toEqual([...everyId].reverse())
  })

  it('returns every row exactly once when the sort column is not unique', async () => {
    const { seen, pages } = await pageThrough('name')
    expect(pages).toBe(3)
    expect(seen).toHaveLength(TOTAL)
    expect(new Set(seen.map((a) => a.id)).size, 'no row appears twice').toBe(TOTAL)
    expect([...seen.map((a) => a.id)].sort()).toEqual([...everyId].sort())
    // Five rows share each name, so a cursor that carried only the name would skip four of them at
    // every page boundary. The order must still be globally non-decreasing.
    const names = seen.map((a) => a.name)
    expect(names).toEqual([...names].sort())
  })

  it('refuses a page marker it did not issue rather than silently returning page one', async () => {
    // The failure this rules out is the quiet one: a cursor that cannot be decoded, swallowed, and
    // an infinite list that serves page one for ever.
    expect(
      await refusedWith(() => listAssets(WS_PAGE, { sort: 'name', limit: 10, cursor: 'nonsense' })),
    ).toBe('BAD_REQUEST')
    const wrongShape = Buffer.from(JSON.stringify({ nope: 1 }), 'utf8').toString('base64url')
    expect(
      await refusedWith(() => listAssets(WS_PAGE, { sort: 'name', limit: 10, cursor: wrongShape })),
    ).toBe('BAD_REQUEST')
  })

  it('refuses a page marker whose row id is not a uuid, rather than handing it to Postgres', async () => {
    // The cursor's id is interpolated into a `::uuid` cast. `decode` used to check only that it was
    // a *string*, so this exact value reached the database as a 22P02 nobody caught: an unhandled
    // 500 and an error-level log line per request, from anyone who could type in the address bar.
    const notAUuid = Buffer.from(JSON.stringify({ i: 'not-a-uuid', s: 'name' }), 'utf8').toString('base64url')
    expect(await refusedWith(() => listAssets(WS_PAGE, { sort: 'name', limit: 10, cursor: notAUuid }))).toBe(
      'BAD_REQUEST',
    )
  })

  it('refuses a page marker issued under a different sort', async () => {
    // Replayed under another ordering, a bookmark cannot be read at all: page two came back equal
    // to page one, so "Load more" served the same ten rows for ever. A cursor names its sort now,
    // and a list that is not that sort refuses it.
    const first = await listAssets(WS_PAGE, { sort: 'recent', limit: 10 })
    expect(first.nextCursor, 'a 25-row list at 10 a page has a second page').not.toBeNull()
    expect(
      await refusedWith(() => listAssets(WS_PAGE, { sort: 'code', limit: 10, cursor: first.nextCursor! })),
    ).toBe('BAD_REQUEST')
  })

  it('issues a cursor the contract can carry, however long the name is', async () => {
    // `Cursor` is `max(512)`. The bookmark used to carry the sort key itself, so a 200-character
    // Persian name — the longest `name` the contract allows — encoded to 602 characters and broke
    // "Load more" with a validation error, in the locales least likely to be tested. The bookmark
    // carries the row id and the sort now, so its size does not depend on the data at all.
    const ws = workspace()
    const long = 'صندلی اداری چرخ‌دار با پشتی مشبک و تنظیم ارتفاع '.repeat(5).slice(0, 200)
    expect(long, 'the longest name the contract allows').toHaveLength(200)
    await createAsset(ws, { name: long })
    await createAsset(ws, { name: `${long.slice(0, 199)}ی` })

    const page = await listAssets(ws, { sort: 'name', limit: 1 })
    expect(page.nextCursor).not.toBeNull()
    expect(
      Cursor.safeParse(page.nextCursor).success,
      'the server must not issue a cursor its own contract will reject on the way back',
    ).toBe(true)

    // And it still pages: a cursor that validates but does not work is the same bug wearing a hat.
    const second = await listAssets(ws, { sort: 'name', limit: 1, cursor: page.nextCursor! })
    expect(second.items.map((a) => a.id)).not.toEqual(page.items.map((a) => a.id))
  })

  it('ends the list when the row a cursor points at has since been deleted', async () => {
    /**
     * Deliberately an empty page rather than a 400.
     *
     * Somebody archiving or deleting a row while another person reads the list is an ordinary race,
     * not a malformed request — an error on "Load more" would blame the reader for it. The row
     * comparison is against a subquery, so a missing anchor makes it NULL and the page comes back
     * empty with no cursor: the list ends where it was, and the next refresh is correct.
     */
    const ws = workspace()
    for (let i = 0; i < 3; i++) await createAsset(ws, { name: `Vanishing ${i}` })

    const first = await listAssets(ws, { sort: 'recent', limit: 1 })
    expect(first.nextCursor).not.toBeNull()
    const anchor = first.items[0]!.id
    await kernel.database.withWorkspace(ws, (tx) =>
      tx.delete(assets).where(and(eq(assets.workspaceId, ws), eq(assets.id, anchor))),
    )

    const second = await listAssets(ws, { sort: 'recent', limit: 1, cursor: first.nextCursor! })
    expect(second.items, 'the page the deleted row bookmarked').toEqual([])
    expect(second.nextCursor, 'and nothing to keep asking for').toBeNull()
  })
})

/**
 * A search box takes text, not a pattern.
 *
 * `%`, `_` and `\` are `ilike` syntax, and interpolated straight into the pattern they turned a
 * search into a wildcard the person did not ask for: `50%` matched every row in the workspace and
 * `_hair` matched "Chair". Both read as a broken search rather than as a clever one.
 */
describe('searching for text that looks like a pattern', () => {
  const WS_LIKE = workspace()
  let chair: Asset
  let throw_: Asset

  beforeAll(async () => {
    chair = await createAsset(WS_LIKE, { name: 'Chair' })
    throw_ = await createAsset(WS_LIKE, { name: '50% cotton throw' })
  }, 60_000)

  it('treats _ as a character, not as "any character"', async () => {
    const page = await listAssets(WS_LIKE, { limit: 50, q: '_hair' })
    expect(
      page.items.map((a) => a.id),
      'unescaped, this matches Chair',
    ).toEqual([])
  })

  it('treats % as a character, not as "anything at all"', async () => {
    const wild = await listAssets(WS_LIKE, { limit: 50, q: '%' })
    expect(
      wild.items.map((a) => a.id),
      'unescaped, this matches every row',
    ).toEqual([throw_.id])

    const literal = await listAssets(WS_LIKE, { limit: 50, q: '50%' })
    expect(literal.items.map((a) => a.id)).toEqual([throw_.id])
  })

  it('still finds the plain text beside them', async () => {
    // The other half: escaping that stripped the characters would break an honest search too.
    const page = await listAssets(WS_LIKE, { limit: 50, q: 'chair' })
    expect(page.items.map((a) => a.id)).toEqual([chair.id])
  })
})

/**
 * Filters, applied by the server.
 *
 * Every one of these used to be — or could plausibly be — a filter the browser applies to the page
 * it was handed, which is wrong the moment there is more than one page: the first twenty rows come
 * back, half are dropped, and the list looks short rather than paged.
 */
describe('narrowing a list', () => {
  let thinkpad: Asset
  let archived: Asset
  let broken: Asset

  beforeAll(async () => {
    thinkpad = await createAsset(WS_FILTER, { name: 'Thinkpad X1', serialNumber: 'SN-QQQ-1' })
    archived = await createAsset(WS_FILTER, { name: 'Retired projector' })
    broken = await createAsset(WS_FILTER, { name: 'Cracked monitor' })
    await call(
      inv.assets.archive,
      { workspaceId: WS_FILTER, assetId: archived.id, archived: true },
      { context: asUser(ALICE, WS_FILTER) },
    )
    // `status` and `custodian_user_id` follow custody and repairs, neither of which has procedures
    // yet, so they are set the way those procedures will set them — directly, in the module's own
    // transaction. The filter is what is under test, not the writer.
    await kernel.database.withWorkspace(WS_FILTER, (tx) =>
      tx
        .update(assets)
        .set({ status: 'under_repair', custodianUserId: BOB })
        .where(and(eq(assets.workspaceId, WS_FILTER), eq(assets.id, broken.id))),
    )
  }, 60_000)

  const ids = (page: { items: Asset[] }) => page.items.map((a) => a.id).sort()

  it('leaves archived rows out unless they are asked for', async () => {
    const live = await listAssets(WS_FILTER, { limit: 50 })
    expect(live.items.map((a) => a.id)).not.toContain(archived.id)
    expect(ids(live)).toEqual([thinkpad.id, broken.id].sort())

    const all = await listAssets(WS_FILTER, { limit: 50, archived: true })
    expect(all.items.map((a) => a.id)).toContain(archived.id)
    expect(ids(all)).toEqual([thinkpad.id, archived.id, broken.id].sort())
  })

  it('narrows by status', async () => {
    const page = await listAssets(WS_FILTER, { limit: 50, status: 'under_repair' })
    expect(ids(page)).toEqual([broken.id])
  })

  it('narrows by custodian', async () => {
    const page = await listAssets(WS_FILTER, { limit: 50, custodianUserId: BOB })
    expect(ids(page)).toEqual([broken.id])
  })

  it('matches a query against the name, the code and the serial', async () => {
    // Three separate reads, because a search that covers only the name is the one somebody notices
    // while standing in front of the machine reading its sticker out loud.
    const byName = await listAssets(WS_FILTER, { limit: 50, q: 'thinkpad' })
    expect(ids(byName)).toEqual([thinkpad.id])

    const byCode = await listAssets(WS_FILTER, { limit: 50, q: thinkpad.code })
    expect(ids(byCode)).toEqual([thinkpad.id])

    const bySerial = await listAssets(WS_FILTER, { limit: 50, q: 'qqq' })
    expect(ids(bySerial)).toEqual([thinkpad.id])
  })
})

/**
 * Tenant isolation through the API, not through the policy.
 *
 * The database is reached as a superuser here, exactly as `core` reaches it in production, so RLS
 * is bypassed and the `workspace_id` predicate in the service is the only thing standing between
 * two customers. That is the predicate this asserts.
 */
describe('two workspaces', () => {
  it('does not let one read the other’s asset', async () => {
    const mine = await createAsset(WS_A, { name: 'Only ours' })
    expect(
      await refusedWith(() =>
        call(inv.assets.get, { workspaceId: WS_B, assetId: mine.id }, { context: asUser(BOB, WS_B) }),
      ),
      'a leak and a 403 are both wrong here: from B, the row does not exist',
    ).toBe('NOT_FOUND')
  })
})

/**
 * The history trail — the module's own authoritative record of what happened, written inside the
 * caller's transaction. Core activity is a best-effort mirror of it and may be missing; this may
 * not be.
 */
describe('the history trail', () => {
  const historyOf = (workspaceId: string, assetId: string) =>
    kernel.database.withWorkspace(workspaceId, (tx) =>
      tx
        .select()
        .from(assetHistory)
        .where(and(eq(assetHistory.workspaceId, workspaceId), eq(assetHistory.assetId, assetId)))
        .orderBy(asc(assetHistory.id)),
    )

  it('records a creation, then an update carrying only the field that moved', async () => {
    // No description on purpose. With one set, this diff also names `description` on a patch that
    // never mentioned it — see "patching one field" below, which is the same defect seen from the
    // other side.
    const asset = await createAsset(WS_A, { name: 'Timeline' })
    await call(
      inv.assets.update,
      { workspaceId: WS_A, assetId: asset.id, name: 'Timeline mk2' },
      { context: asUser(ALICE) },
    )

    const rows = await historyOf(WS_A, asset.id)
    expect(rows.map((r) => r.action)).toEqual(['created', 'updated'])
    expect(rows[1]?.changes).toEqual([{ field: 'name', from: 'Timeline', to: 'Timeline mk2' }])
    expect(rows[1]?.actorId).toBe(ALICE)
  })

  it('writes nothing for an update that changes nothing', async () => {
    // A timeline that logs a no-op is a timeline nobody reads, and "somebody touched this" is not
    // what the page promises.
    const asset = await createAsset(WS_A, { name: 'Unmoved' })
    await call(
      inv.assets.update,
      { workspaceId: WS_A, assetId: asset.id, name: 'Unmoved' },
      { context: asUser(ALICE) },
    )
    const rows = await historyOf(WS_A, asset.id)
    expect(rows.map((r) => r.action)).toEqual(['created'])
  })

  it('records archiving and restoring under their own actions', async () => {
    const asset = await createAsset(WS_A, { name: 'Round trip' })
    const ctx = { context: asUser(ALICE) }
    await call(inv.assets.archive, { workspaceId: WS_A, assetId: asset.id, archived: true }, ctx)
    const back = await call(
      inv.assets.archive,
      { workspaceId: WS_A, assetId: asset.id, archived: false },
      ctx,
    )
    expect(back.archivedAt).toBeNull()
    const rows = await historyOf(WS_A, asset.id)
    expect(rows.map((r) => r.action)).toEqual(['created', 'retired', 'restored'])
  })
})

/**
 * `undefined` means "not mentioned"; `null` means "clear it".
 *
 * Collapsing the two is how an edit of one field quietly wipes the others, and the wipe is silent —
 * the request succeeds, the screen redraws, and the location the person spent a morning filling in
 * is gone.
 */
describe('patching one field', () => {
  it('leaves a field the patch never mentioned alone', async () => {
    const asset = await createAsset(WS_A, { name: 'Desk lamp', location: 'Desk 4' })
    const patched = await call(
      inv.assets.update,
      { workspaceId: WS_A, assetId: asset.id, name: 'Desk lamp (tall)' },
      { context: asUser(ALICE) },
    )
    expect(patched.name).toBe('Desk lamp (tall)')
    expect(patched.location, 'a patch that never named location must not clear it').toBe('Desk 4')
  })

  it('clears a field the patch explicitly passes as null', async () => {
    const asset = await createAsset(WS_A, { name: 'Loose cable', location: 'Drawer' })
    const patched = await call(
      inv.assets.update,
      { workspaceId: WS_A, assetId: asset.id, location: null },
      { context: asUser(ALICE) },
    )
    expect(patched.location).toBeNull()
  })

  it('leaves a description the patch never mentioned alone', async () => {
    /**
     * The same rule as the two above, and the one field that breaks it.
     *
     * `AssetInput.description` carries `.default('')`, and `.partial()` does not remove a default —
     * it wraps the field in `optional`, and zod still substitutes the default for a missing key. So
     * a PATCH of `{ name }` arrives at the handler as `{ name, description: '' }`, `AssetService`
     * correctly reads that as "clear it", and the description is destroyed by a rename. The
     * `undefined`-versus-`null` care in the service is defeated one layer above it, in the contract.
     */
    const asset = await createAsset(WS_A, { name: 'Server rack', description: 'Second floor, bolted' })
    const patched = await call(
      inv.assets.update,
      { workspaceId: WS_A, assetId: asset.id, name: 'Server rack B' },
      { context: asUser(ALICE) },
    )
    expect(patched.description, 'a rename must not wipe the description').toBe('Second floor, bolted')
  })
})
