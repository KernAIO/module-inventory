import { randomUUID } from 'node:crypto'
import {
  Cursor,
  type core,
  defineEvent,
  type EntityChange,
  type Principal,
  type WorkspaceId,
} from '@kernhq/contracts'
import { CAPABILITIES_KEY, createKernel, type Kernel, type RequestContext, type Tx } from '@kernhq/kernel'
import { call } from '@orpc/server'
import { and, asc, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type Asset, MAX_LIVE_CATEGORIES } from '../contract/models.js'
import { inventoryModule } from './index.js'
import { activeWorkspaces, reconcileStatuses } from './jobs.js'
import { inventoryRouter } from './router.js'
import {
  assetHistory,
  assets,
  categories as categoriesTable,
  custodyPeriods,
  repairs,
  TENANT_TABLES,
  workspaces,
} from './schema.js'
import { inventoryServices } from './services/index.js'

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
const WS_CUSTODY = workspace()
const WS_CAT = workspace()
/**
 * Its own, because `reorder` insists on being handed **every** live category the workspace has —
 * so a test sharing a workspace with the block above would be ordering whatever that block happened
 * to have created by then, and would break the first time somebody added a case to it.
 */
const WS_ORDER = workspace()
/**
 * Its own, because the point of it is two transactions appending to the same list at the same
 * moment — and a workspace shared with `WS_ORDER` would have its sequence rewritten underneath it.
 */
const WS_UNIQUE = workspace()
/** Its own, because it fills up: every other block's `create` would be refused inside it. */
const WS_LIMIT = workspace()
const WS_REPAIR = workspace()
const WS_FILES = workspace()
const WS_STATS = workspace()
/** Its own workspace, because a capability is switched off for a whole workspace at a time. */
const WS_CAP = workspace()
/**
 * Its own again, and separate from `WS_CAP` on purpose.
 *
 * `WS_CAP` proves the gate — every repairs procedure answers 404 — and this one proves what the
 * workspace can still *do* while the gate is shut, which needs assets to be created, handed over and
 * archived under the switch rather than only refused. Mixing the two would leave one block's leftover
 * repairs deciding the other block's statuses.
 */
const WS_STRAND = workspace()
/** Its own, because the sweeps read every registered workspace and must not see anybody else's. */
const WS_SWEEP = workspace()
/** Its own, because `onWorkspaceEnabled` only seeds a workspace that has no categories at all. */
const WS_SEED = workspace()
/** A registered workspace with nobody in it, so a sweep finds a row and nobody to tell about it. */
const WS_SILENT = workspace()
/** Its own, and never registered in `mod_inventory.workspaces`, so the sweeps skip it. */
const WS_LEAVER = workspace()
/**
 * Registered, and deliberately empty: the scheduler's enumeration is what it is here to prove, and a
 * workspace with no assets and no repairs gives every sweep nothing to say about it.
 */
const WS_REGISTRY = workspace()
/** A workspace with HR but with Inventory switched off, which must hear nothing. */
const WS_NO_INVENTORY = workspace()
const WS_SEARCH = workspace()

const ALICE = randomUUID()
const BOB = randomUUID()
/** Somebody who leaves, and the office manager who has to collect their laptop. */
const DANA = randomUUID()
const OLIVE = randomUUID()

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

/**
 * What core says this workspace has switched on, when a test wants to say something.
 *
 * `null` means "a workspace that has never touched the switchboard" — empty settings, which is what
 * every test outside the capability block runs against, and which resolves to `repairs` and
 * `attachments` **on**, because both are `defaultEnabled`. `withCapabilities` below is how the 404
 * tests switch one off.
 */
let capabilityOverride: Record<string, boolean> | null = null

/**
 * What this module asked core to do, recorded rather than discarded.
 *
 * The stubs used to answer `{ ok: true }` and forget, which is enough for a test that only cares
 * that a mutation did not throw — and useless for the four surfaces that exist *entirely* to send
 * something out of the module. A notification nobody can assert on is a notification nobody can
 * prove is addressed to the right person.
 */
interface SentNotification {
  userId: string
  workspaceId: string
  type: string
  title: string
  body: string | null
  url: string | null
  data: Record<string, unknown>
}
const NOTIFICATIONS: SentNotification[] = []

/**
 * Core refusing to write a notification, on demand.
 *
 * Every side effect this module has is best-effort — a failed `core.notifications.create` is logged
 * and swallowed — and the two nightly sweeps write a permanent "told them" marker beside it. Whether
 * that marker is honest is only answerable by making the call fail, so the stub can be made to.
 */
let notificationsFail = false

/**
 * Core refusing to write a notification **for some people and not others**.
 *
 * The all-or-nothing switch above cannot reach the defect this exists for: a sweep sends to an
 * audience, and `core.notifications.create` is one call per recipient, so "the notice went out" and
 * "the notice went out to everybody" are different facts and the marker column can only hold one of
 * them. Failing exactly one recipient is the only way to tell which one the sweep is recording.
 */
const NOTIFICATIONS_FAIL_FOR = new Set<string>()

/**
 * Every realtime change this module announced, in order.
 *
 * `kernel.realtime.change` is the only thing that redraws a screen somebody is looking at, and what
 * it carries — the entity and the id — is a claim about which row moved. Nothing could assert on it
 * before, so a change naming the wrong noun was invisible to the whole suite.
 */
const CHANGES: Array<{ workspaceId: string } & EntityChange> = []

const INDEXED: core.SearchDocument[] = []
const UNINDEXED: Array<{ workspaceId: string; object: { module: string; type: string; id: string } }> = []

/** Workspaces this instance is pretending have Inventory switched **off**. */
const MODULE_OFF = new Set<string>()

/** Membership, as core would report it — the input to every "who should be told" question. */
const MEMBERS = new Map<string, Array<{ userId: string; role: string }>>()
/** Names, so a notification can say who somebody is rather than printing a uuid. */
const USERS = new Map<string, { id: string; name: string | null; email: string }>()

/** HR, when a test is pretending the workspace has it. `null` means nothing hosts `hr.*`. */
const PEOPLE = new Map<string, { id: string; userId: string | null; status: string }>()

const seedMember = (workspaceId: string, userId: string, role: string, name: string) => {
  MEMBERS.set(workspaceId, [...(MEMBERS.get(workspaceId) ?? []), { userId, role }])
  USERS.set(userId, { id: userId, name, email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.test` })
}

/**
 * Alice and Bob belong to the workspaces this suite hands things over in.
 *
 * `custody.assign` and `custody.transfer` ask core whether the person being handed the item is
 * really a member before they write it — an id in a request is a claim, and it used to be believed.
 * So a workspace where a handover is expected to *succeed* has to have members, and the fixture is
 * the same map every audience question is answered from rather than a second one that could
 * disagree with it.
 *
 * Seeded here rather than in a `beforeAll`, so the blocks that are *about* an audience build their
 * own rolls untouched: `WS_SWEEP` and `WS_LEAVER` name exactly who they mean, and `WS_SILENT` is a
 * registered workspace with nobody in it at all.
 */
for (const workspaceId of [
  WS_A,
  WS_B,
  WS_CUSTODY,
  WS_REPAIR,
  WS_STATS,
  WS_SEARCH,
  WS_CAP,
  WS_STRAND,
  WS_FILES,
]) {
  seedMember(workspaceId, ALICE, 'admin', 'Alice Ng')
  seedMember(workspaceId, BOB, 'member', 'Bob Ito')
}

const notificationsOfType = (type: string) => NOTIFICATIONS.filter((n) => n.type === type)

function registerCoreStubs(k: Kernel) {
  k.broker.register('core', {
    'activity.record': { handler: async () => ({ ok: true }) },
    'notifications.create': {
      handler: async (input: SentNotification) => {
        if (notificationsFail || NOTIFICATIONS_FAIL_FOR.has(input.userId))
          throw new Error('core is having a bad night')
        NOTIFICATIONS.push(input)
        return { ok: true }
      },
    },
    'search.index': {
      handler: async (input: { documents: core.SearchDocument[] }) => {
        INDEXED.push(...input.documents)
        return { ok: true }
      },
    },
    'search.remove': {
      handler: async (input: { refs: (typeof UNINDEXED)[number][] }) => {
        UNINDEXED.push(...input.refs)
        return { ok: true }
      },
    },
    'modules.isEnabled': {
      handler: async (input: { workspaceId: string }) => !MODULE_OFF.has(input.workspaceId),
    },
    'authz.customRolePermissions': { handler: async () => [] },
    'authz.bindings': { handler: async () => [] },
    /** Everybody the workspace has, which is what an audience is worked out from. */
    'workspaces.members': {
      handler: async (input: { workspaceId: string }) =>
        (MEMBERS.get(input.workspaceId) ?? []).map((m) => ({ ...m, roleIds: [], groupIds: [] })),
    },
    /**
     * A principal per member, because `membersWithPermission` asks the real `kernel.authz` rather
     * than guessing from a role — so the audience test is a test of the permission system and not
     * of a lookup table.
     */
    'users.principal': {
      handler: async (input: { userId: string }) => {
        const memberships = [...MEMBERS].flatMap(([workspaceId, rows]) =>
          rows
            .filter((row) => row.userId === input.userId)
            .map((row) => ({ workspaceId, role: row.role, roleIds: [], groupIds: [], status: 'active' })),
        )
        return {
          kind: 'user',
          userId: input.userId,
          email: USERS.get(input.userId)?.email ?? null,
          name: USERS.get(input.userId)?.name ?? null,
          locale: 'en',
          instanceAdmin: false,
          service: null,
          memberships,
          permissionVersion: 0,
        }
      },
    },
    'users.get': { handler: async (input: { id: string }) => USERS.get(input.id) ?? null },
    // Empty settings is what a workspace that never opened the module has: `InventorySettings`
    // fills in `INV-`/4 from its own defaults, and `resolveCapabilities` fills in the two switches
    // from theirs.
    'settings.getModule': {
      handler: async () => (capabilityOverride ? { [CAPABILITIES_KEY]: capabilityOverride } : {}),
    },
    'settings.setModule': { handler: async () => ({ ok: true }) },
    // What `AttachmentService.describe` asks before recording a file. The real answer is core's
    // file record; this is the smallest thing that carries the two fields the module checks —
    // the owning workspace and whether the upload finished.
    'files.get': {
      handler: async (input: { id: string }) => FILES.get(input.id) ?? null,
    },
  })
}

/**
 * The files core is pretending to hold, keyed by id.
 *
 * A module records that an asset has a file and copies its name and size; it never sees a byte. The
 * two rows a test needs are a normal one and a wrong one — a file belonging to another workspace,
 * which is the check that stops one workspace reading another's file names through this module.
 */
const FILES = new Map<
  string,
  { id: string; workspaceId: string; name: string; mimeType: string; size: number; status: string }
>()

const seedFile = (workspaceId: string, name: string, status = 'ready') => {
  const id = randomUUID()
  FILES.set(id, { id, workspaceId, name, mimeType: 'application/pdf', size: 12_345, status })
  return id
}

/**
 * Run one block with a different set of capabilities switched on.
 *
 * The kernel caches module settings for fifteen seconds, so flipping the stub is not enough —
 * `invalidate` is what makes the next call actually ask again. Restored in a `finally`, because a
 * test that leaves `repairs` off makes every later test in the file 404 for reasons it never
 * mentions.
 */
async function withCapabilities(
  on: Record<string, boolean>,
  fn: () => Promise<void>,
  workspaceIds: string[] = [WS_CAP],
): Promise<void> {
  capabilityOverride = on
  for (const id of workspaceIds) kernel.settings.invalidate(id)
  try {
    await fn()
  } finally {
    capabilityOverride = null
    for (const id of workspaceIds) kernel.settings.invalidate(id)
  }
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

  // Recorded on the way through rather than replaced: the real publisher still runs, so this cannot
  // make a broken announcement look like a working one.
  const announced = kernel.realtime.change.bind(kernel.realtime)
  kernel.realtime.change = async (workspaceId: string, change: EntityChange) => {
    CHANGES.push({ workspaceId, ...change })
    return announced(workspaceId, change)
  }

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
  categoryId?: string | null
  serialNumber?: string | null
  location?: string | null
  purchasedOn?: string | null
  warrantyUntil?: string | null
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
function codeOf(err: unknown): string | null {
  let cursor: unknown = err
  for (let depth = 0; depth < 5 && cursor; depth++) {
    const code = (cursor as { code?: unknown }).code
    if (typeof code === 'string') return code
    cursor = (cursor as { cause?: unknown }).cause
  }
  return null
}

/** The sentence a refusal carried, which is the half a person actually reads. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The stable token a refusal carried, which is the half a *client* reads.
 *
 * The message is prose that changes when somebody rewords it; the reason is what
 * `src/client/errors.ts` branches on to show a translated sentence instead of the server's English.
 * Asserting on it is how a test proves a Persian reader gets Persian. Reached through `cause` and
 * out of `data` for the same reasons `codeOf` is: `kernErrorToORPC` folds it into `data`, while a
 * `KernError` thrown in-process carries it on itself.
 */
function reasonOf(err: unknown): string | null {
  let cursor: unknown = err
  for (let depth = 0; depth < 5 && cursor; depth++) {
    const found =
      (cursor as { data?: { reason?: unknown } }).data?.reason ?? (cursor as { reason?: unknown }).reason
    if (typeof found === 'string') return found
    cursor = (cursor as { cause?: unknown }).cause
  }
  return null
}

async function refusedWith(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (err) {
    const code = codeOf(err)
    if (code) return code
    throw new Error(`Rejected, but with no error code: ${String(err)}`)
  }
  throw new Error('Expected the call to be refused, but it succeeded')
}

/**
 * The refusal itself, for the cases that assert more than its code — its reason token, or the
 * sentence the server wrote. A call that succeeds is the failure, and says so.
 */
async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (err) {
    return err
  }
  throw new Error('Expected the call to be refused, but it succeeded')
}

/**
 * Wait until Postgres says a backend on this database is blocked on a lock.
 *
 * The one honest way to know that a second transaction has reached its insert and is queued behind
 * the first. A `setTimeout` guesses at it, and guesses wrong under load — which does not merely make
 * the test slow, it makes the *other* transaction the winner and the assertions nonsense. Polling
 * the database's own view of who is waiting is deterministic on any machine.
 *
 * A blocked insert on an exclusion constraint waits on the other transaction's id, so
 * `wait_event_type` is `Lock`.
 */
async function waitForBlockedBackend(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { rows } = await kernel.database.pool.query<{ n: number }>(
      `select count(*)::int as n
         from pg_stat_activity
        where datname = $1 and state = 'active' and wait_event_type = 'Lock'`,
      [DB_NAME],
    )
    if ((rows[0]?.n ?? 0) > 0) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('No backend ever blocked on a lock — the second transaction never reached its insert')
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

/**
 * The `repairs` capability, as the router resolves it before opening a transaction.
 *
 * The custody verbs and `assets.archive` take it as an argument rather than reading it, because
 * `kernel.capabilities` is a settings read over the broker and this module never awaits one while
 * holding a pooled connection. Every test that drives those services **directly** — the ones holding
 * two transactions open at once, which cannot go through the router — has to supply the same answer
 * the router would have. Every one of them runs in a workspace that has never touched the
 * switchboard, so the answer is `true`: `repairs` is `defaultEnabled`.
 */
const RECORDS_REPAIRS = true

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
    // Through the module's own path, so what the enumeration finds is what a workspace switching
    // Inventory on actually writes.
    await inventoryModule.onWorkspaceEnabled?.(WS_REGISTRY, kernel)

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

  /**
   * The scheduler's enumeration, run as the role a deployment actually uses.
   *
   * `mod_inventory.workspaces` is the registry both nightly sweeps start from, and a cron handler is
   * woken by a clock — so it has no workspace and `app.workspace_id` is unset for it by definition.
   * The table's per-workspace policy therefore matched nothing, and `force row level security`
   * subjects the schema's **owner** to its policies as well: only a superuser is exempt. So this read
   * answered zero rows on any ordinary deployment. No error, no warning — both sweeps simply found
   * nothing to do, every night, and the development database is a superuser, which is exactly why
   * nothing noticed.
   *
   * The real `activeWorkspaces` is called rather than a query that resembles it, against a drizzle
   * handle over this role's own connection. A test that reproduced the SQL by hand would pass on a
   * job that had since started reading something else.
   */
  it('lets the scheduler enumerate every registered workspace, as a role that cannot bypass RLS', async () => {
    await plain.query('reset app.workspace_id')
    const asPlainRole = { database: { db: drizzle({ client: plain }) } } as unknown as Kernel

    const ids = await activeWorkspaces(asPlainRole)
    expect(ids, 'a sweep that finds no workspaces has nothing to sweep, silently and for ever').toContain(
      WS_REGISTRY,
    )

    // And nothing else opened up: the same unbound session still sees no tenant data at all.
    expect(await count('select count(*) as n from mod_inventory.assets')).toBe(0)
    expect(await count('select count(*) as n from mod_inventory.custody_periods')).toBe(0)
  })

  it('still shows a workspace-bound session only its own registry row', async () => {
    await plain.query(`set app.workspace_id = '${WS_A}'`)
    expect(
      await count(`select count(*) as n from mod_inventory.workspaces where workspace_id = '${WS_REGISTRY}'`),
      'the extra policy is for a session with no workspace, and widens nothing for one that has one',
    ).toBe(0)
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

/**
 * Custody, the invariant this phase exists for.
 *
 * Three verbs, and every one of them has to leave four things in step inside **one** transaction:
 * the period rows, `assets.custodian_user_id`, `assets.custody_since` and `assets.status`, plus an
 * `asset_history` entry. Any test that checks one of the four and not the others would pass against
 * a service that had come apart, which is precisely the failure the design is guarding against.
 */
describe('handing an item over', () => {
  /**
   * Built on call, not once at the top of the block.
   *
   * A `describe` body runs at collection time — before `beforeAll` — so a context captured there
   * holds `kernel: undefined`, and every procedure fails inside `workspaceScoped` with
   * "Cannot read properties of undefined (reading 'authz')". That is not the module refusing the
   * call; it is the test never reaching it, and it looks identical from the assertion.
   */
  const ctx = () => ({ context: asUser(ALICE, WS_CUSTODY) })

  const assign = (assetId: string, userId: string, note?: string) =>
    call(inv.custody.assign, { workspaceId: WS_CUSTODY, assetId, userId, note }, ctx())
  const transfer = (assetId: string, userId: string, note?: string) =>
    call(inv.custody.transfer, { workspaceId: WS_CUSTODY, assetId, userId, note }, ctx())
  const take = (assetId: string, note?: string) =>
    call(inv.custody.return, { workspaceId: WS_CUSTODY, assetId, note }, ctx())
  const periodsOf = (assetId: string) =>
    call(inv.custody.history, { workspaceId: WS_CUSTODY, assetId }, ctx())
  const actionsOf = async (assetId: string) =>
    (await call(inv.assets.history, { workspaceId: WS_CUSTODY, assetId }, ctx())).items.map((e) => e.action)

  it('opens a period and brings the three columns on the asset into step', async () => {
    const item = await createAsset(WS_CUSTODY, { name: 'Projector' })
    expect(item.status).toBe('in_stock')

    const { asset, period } = await assign(item.id, BOB, 'For the all-hands')
    expect(asset.custodianUserId).toBe(BOB)
    expect(asset.custodySince).toBeTruthy()
    expect(asset.status, 'status follows custody, in the same transaction').toBe('assigned')
    expect(period?.effectiveTo, 'the open period is the one with no end').toBeNull()
    expect(period?.note).toBe('For the all-hands')
    // Written by the same transaction, not by a job afterwards.
    expect(await actionsOf(item.id)).toEqual(['assigned', 'created'])
  })

  it('closes the period and clears all three columns on return', async () => {
    const item = await createAsset(WS_CUSTODY, { name: 'Label printer' })
    await assign(item.id, BOB)
    const { asset, period } = await take(item.id)
    expect(asset.custodianUserId).toBeNull()
    expect(asset.custodySince).toBeNull()
    expect(asset.status).toBe('in_stock')
    expect(period, 'a return closes something and opens nothing').toBeNull()

    const rows = await periodsOf(item.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.effectiveTo).toBeTruthy()
    expect(await actionsOf(item.id)).toEqual(['returned', 'assigned', 'created'])
  })

  it('hands on in one transaction, leaving no stretch during which nobody held it', async () => {
    /**
     * The reason `transfer` is a procedure rather than a return followed by an assign.
     *
     * Two calls would leave the asset `in_stock` with no custodian in between — visible to anybody
     * reading the list at that instant, and permanently visible in the timeline as a return nobody
     * performed. One instant for both halves is what makes the periods abut: `[…, at)` and
     * `[at, …)` do not overlap and leave no gap.
     */
    const item = await createAsset(WS_CUSTODY, { name: 'Camera body' })
    await assign(item.id, ALICE)
    const { asset } = await transfer(item.id, BOB, 'Handing it to Bob')
    expect(asset.custodianUserId).toBe(BOB)
    expect(asset.status).toBe('assigned')

    const rows = await periodsOf(item.id)
    expect(rows).toHaveLength(2)
    const [open, closed] = rows
    expect(open?.userId).toBe(BOB)
    expect(open?.effectiveTo).toBeNull()
    expect(closed?.userId).toBe(ALICE)
    expect(closed?.effectiveTo, 'the periods abut exactly').toBe(open?.effectiveFrom)
    expect(await actionsOf(item.id)).toEqual(['transferred', 'assigned', 'created'])
  })

  it('records who received it and who gave it up, as ids', async () => {
    const item = await createAsset(WS_CUSTODY, { name: 'Tripod' })
    await assign(item.id, ALICE)
    await transfer(item.id, BOB)
    await take(item.id)
    const { items } = await call(inv.assets.history, { workspaceId: WS_CUSTODY, assetId: item.id }, ctx())
    const byAction = new Map(items.map((e) => [e.action, e.data]))
    expect(byAction.get('assigned')).toMatchObject({ userId: ALICE })
    expect(byAction.get('transferred')).toMatchObject({ userId: BOB, previousUserId: ALICE })
    // A return stores no `userId` at all — the client reads `previousUserId` for that sentence.
    expect(byAction.get('returned')).toMatchObject({ previousUserId: BOB })
  })

  it('refuses assigning something somebody already holds, with a sentence rather than a 500', async () => {
    const item = await createAsset(WS_CUSTODY, { name: 'Contested drill' })
    await assign(item.id, ALICE)
    await expect(assign(item.id, BOB)).rejects.toSatisfy(
      (err: unknown) => codeOf(err) === 'CONFLICT' && /holding this item/i.test(messageOf(err)),
    )
  })

  it('refuses handing on and taking back something nobody holds', async () => {
    const item = await createAsset(WS_CUSTODY, { name: 'Spare monitor' })
    expect(await refusedWith(() => transfer(item.id, BOB))).toBe('CONFLICT')
    expect(await refusedWith(() => take(item.id))).toBe('CONFLICT')
  })

  it('refuses handing over an archived item', async () => {
    const item = await createAsset(WS_CUSTODY, { name: 'Retired scanner' })
    await call(inv.assets.archive, { workspaceId: WS_CUSTODY, assetId: item.id, archived: true }, ctx())
    expect(await refusedWith(() => assign(item.id, BOB))).toBe('CONFLICT')
  })

  it('refuses archiving something somebody is still holding', async () => {
    // Somebody is answerable for the thing; taking it out of the register does not change that, it
    // only stops anybody being able to find out — and "what does Bob still have?" excludes archived
    // rows, so the item would quietly stop being counted while still being in his bag.
    const item = await createAsset(WS_CUSTODY, { name: 'Held laptop' })
    await assign(item.id, BOB)
    expect(
      await refusedWith(() =>
        call(inv.assets.archive, { workspaceId: WS_CUSTODY, assetId: item.id, archived: true }, ctx()),
      ),
    ).toBe('CONFLICT')
  })

  it('answers what one person is holding, and stops counting it once it comes back', async () => {
    const held = await createAsset(WS_CUSTODY, { name: 'Bob’s headset' })
    await assign(held.id, BOB)
    const before = await call(inv.custody.byUser, { workspaceId: WS_CUSTODY, userId: BOB }, ctx())
    expect(before.items.map((a) => a.id)).toContain(held.id)
    await take(held.id)
    const after = await call(inv.custody.byUser, { workspaceId: WS_CUSTODY, userId: BOB }, ctx())
    expect(after.items.map((a) => a.id)).not.toContain(held.id)
  })

  it('does not show one workspace another’s custody trail', async () => {
    const mine = await createAsset(WS_CUSTODY, { name: 'Ours alone' })
    await assign(mine.id, BOB)
    expect(
      await refusedWith(() =>
        call(inv.custody.history, { workspaceId: WS_B, assetId: mine.id }, { context: asUser(BOB, WS_B) }),
      ),
      'an empty list would read as "nothing has ever happened to it", which is not the truth',
    ).toBe('NOT_FOUND')
  })
})

/**
 * The race the exclusion constraint exists for.
 *
 * `inventory_custody_no_overlap` makes two open periods for one asset impossible in the database
 * rather than merely unlikely in the service — there is deliberately no `select … for update` on the
 * asset row, because locking would serialise two people pressing *Hand over* into two successful
 * handovers, which is a worse answer wearing the clothes of a safer one.
 *
 * What the service owes the loser is a sentence they can act on. Without the translation in
 * `db-errors.ts` the loser is shown drizzle's own "Failed query: insert into
 * mod_inventory.custody_periods …", which tells a person nothing and reads as the product breaking
 * rather than as somebody else getting there first.
 */
describe('two people handing the same item over at once', () => {
  it('lets exactly one win, and tells the other what happened', async () => {
    /**
     * Two requests, launched together.
     *
     * Which of the two guards catches the loser is **timing**, and deliberately not asserted: on a
     * laptop the first transaction usually commits before the second one reads, so the loser meets
     * the service's own "somebody else is holding this" check; under real concurrency it gets past
     * that read and the constraint catches it instead. Both are correct, and pinning the message
     * here would make the test fail on a slower machine for no defect. What must hold either way is
     * that exactly one period opens and the loser is told something a person can act on — the
     * constraint's own path is proven on its own below.
     */
    const item = await createAsset(WS_CUSTODY, { name: 'One projector, two hands' })
    const attempt = (userId: string) =>
      call(
        inv.custody.assign,
        { workspaceId: WS_CUSTODY, assetId: item.id, userId },
        { context: asUser(userId, WS_CUSTODY) },
      )

    const results = await Promise.allSettled([attempt(ALICE), attempt(BOB)])
    const won = results.filter((r) => r.status === 'fulfilled')
    const lost = results.filter((r) => r.status === 'rejected')
    expect(won, 'exactly one of the two may open a period').toHaveLength(1)
    expect(lost).toHaveLength(1)

    const reason = (lost[0] as PromiseRejectedResult).reason
    expect(codeOf(reason), 'a lost race is a conflict, not an unhandled 500').toBe('CONFLICT')
    expect(
      messageOf(reason),
      'the loser must not be shown drizzle’s "Failed query: insert into …"',
    ).not.toMatch(/failed query/i)
    expect(messageOf(reason), 'and it has to be a sentence, not a constraint name').toMatch(/\s/)

    // And the database agrees with the winner: one open period, one custodian, one status.
    const rows = await call(
      inv.custody.history,
      { workspaceId: WS_CUSTODY, assetId: item.id },
      {
        context: asUser(ALICE, WS_CUSTODY),
      },
    )
    expect(rows.filter((p) => p.effectiveTo === null)).toHaveLength(1)
    const after = await call(
      inv.assets.get,
      { workspaceId: WS_CUSTODY, assetId: item.id },
      {
        context: asUser(ALICE, WS_CUSTODY),
      },
    )
    expect(after.status).toBe('assigned')
    expect(after.custodianUserId).toBe(rows.find((p) => p.effectiveTo === null)?.userId)
  })

  it('turns the exclusion violation itself into a sentence, not a driver dump', async () => {
    /**
     * The constraint's own path, forced rather than raced for.
     *
     * The test above cannot guarantee it reaches here: two requests launched together usually
     * serialise on a laptop, and the loser meets the service's read-first check instead. So this one
     * drives `CustodyService` through two transactions held open at once, which is exactly the
     * interleaving a busy instance produces and a `Promise.all` on one event loop does not:
     *
     *   1. A inserts its period and **does not commit**;
     *   2. B reads — A's row is invisible, so B correctly believes nobody holds the item — and
     *      inserts, where Postgres blocks it on `inventory_custody_no_overlap`;
     *   3. A commits, B's insert is refused with SQLSTATE 23P01.
     *
     * Without `db-errors.ts` walking `cause` to find the driver's `constraint`, step 3 surfaces as
     * drizzle's "Failed query: insert into mod_inventory.custody_periods …" — an unhandled 500 that
     * reads as the product breaking rather than as somebody else getting there first.
     *
     * It calls the service rather than the router on purpose: the router would open its own
     * transaction and there would be nothing to hold. The gates the router adds are checked by
     * `module.test.ts`, and the subject here is the database.
     *
     * **Both handovers are waited for rather than slept through**, and that is the difference
     * between a test and a coin toss. Sleeping 100ms between the steps failed about one run in ten
     * on a loaded machine, in the worst way: if B got to its insert before A's landed, *B* won and
     * *A* was the one refused, so the test failed on `await a` with an error about the wrong
     * transaction. Step 1 is signalled from inside A's own transaction, and step 2 is read out of
     * `pg_stat_activity` — B is only unblocked once Postgres says it is waiting on a lock.
     */
    const svc = inventoryServices(kernel)
    const item = await createAsset(WS_CUSTODY, { name: 'Held open on purpose' })

    let aHasInserted!: () => void
    const inserted = new Promise<void>((resolve) => {
      aHasInserted = resolve
    })
    let commitA!: () => void
    const holdA = new Promise<void>((resolve) => {
      commitA = resolve
    })

    const a = kernel.database.withWorkspace(
      WS_CUSTODY,
      async (tx) => {
        await svc.custody.assign(tx, WS_CUSTODY, ALICE, item.id, ALICE, null, RECORDS_REPAIRS)
        aHasInserted()
        await holdA
      },
      { userId: ALICE },
    )
    // A's period row exists and is uncommitted: its lock is held, so B cannot get in front of it.
    await inserted

    const b = kernel.database.withWorkspace(
      WS_CUSTODY,
      (tx) => svc.custody.assign(tx, WS_CUSTODY, BOB, item.id, BOB, null, RECORDS_REPAIRS),
      { userId: BOB },
    )
    /**
     * Attached now, so the rejection this test is *about* is never an unhandled one while the poll
     * below is running — vitest fails a suite on those, and it would point at the wrong thing.
     */
    const bSettled = b.then(
      () => null,
      (err: unknown) => err,
    )

    await waitForBlockedBackend()
    commitA()
    await a

    const reason = await bSettled
    expect(reason, 'B must lose: A inserted first and held the lock').not.toBeNull()
    expect(codeOf(reason), 'an exclusion violation is a conflict').toBe('CONFLICT')
    expect(messageOf(reason)).not.toMatch(/failed query/i)
    expect(messageOf(reason), 'and it says what to do about it').toMatch(/reload/i)

    // One winner, and the asset agrees with it.
    const rows = await call(
      inv.custody.history,
      { workspaceId: WS_CUSTODY, assetId: item.id },
      { context: asUser(ALICE, WS_CUSTODY) },
    )
    expect(rows.filter((p) => p.effectiveTo === null)).toHaveLength(1)
    expect(rows[0]?.userId).toBe(ALICE)
  })
})

/**
 * The instants a custody trail is made of.
 *
 * Both of these were written by `max(now(), open.effectiveFrom)`, and both of them are what happens
 * when that expression's two arguments stop being ordered the way it assumes. A JS `Date` resolves
 * to the millisecond, so "two handovers in the same millisecond" is not exotic, and a clock that
 * steps backwards — an NTP correction, a VM resuming, two `core` replicas disagreeing — puts a
 * timestamp already in the table ahead of `now()` for as long as the correction lasts.
 *
 * The rows are written directly here rather than raced for, because the mechanism is arithmetic and
 * not concurrency: a period whose start is ahead of the clock is exactly the state either cause
 * leaves behind, and it is the state the code has to survive.
 */
describe('the clock a handover is dated by', () => {
  const ctx = () => ({ context: asUser(ALICE, WS_CUSTODY) })

  it('never records a period nobody held the item for', async () => {
    const item = await createAsset(WS_CUSTODY, { name: 'Handed on within a millisecond' })
    // A period that started "now" as far as the next change is concerned. `max(now, from)` collapsed
    // the closing instant onto the opening one, and `[t, t)` is an *empty* range — which is why the
    // exclusion constraint waved it through instead of catching it: an empty range overlaps nothing.
    // What it leaves behind is a row saying somebody held the item for no time at all.
    const started = new Date(Date.now() + 5_000)
    await inWs(WS_CUSTODY)((tx) =>
      tx.insert(custodyPeriods).values({
        workspaceId: WS_CUSTODY,
        assetId: item.id,
        userId: ALICE,
        effectiveFrom: started,
      }),
    )

    await call(inv.custody.transfer, { workspaceId: WS_CUSTODY, assetId: item.id, userId: BOB }, ctx())

    const periods = await call(inv.custody.history, { workspaceId: WS_CUSTODY, assetId: item.id }, ctx())
    const closed = periods.find((p) => p.userId === ALICE)
    const open = periods.find((p) => p.effectiveTo === null)
    expect(
      new Date(closed?.effectiveTo ?? 0).getTime(),
      'a period that ends when it began is a name nobody can act on in "who had this in March"',
    ).toBeGreaterThan(new Date(closed?.effectiveFrom ?? 0).getTime())
    // And still abutting, so the trail has no gap during which the item was held by nobody.
    expect(open?.effectiveFrom).toBe(closed?.effectiveTo)
    expect(open?.userId).toBe(BOB)
  })

  it('opens the next period after the last one ended, rather than refusing the handover', async () => {
    const item = await createAsset(WS_CUSTODY, { name: 'After the clock stepped back' })
    const from = new Date(Date.now() + 10_000)
    const to = new Date(Date.now() + 20_000)
    await inWs(WS_CUSTODY)((tx) =>
      tx.insert(custodyPeriods).values({
        workspaceId: WS_CUSTODY,
        assetId: item.id,
        userId: ALICE,
        effectiveFrom: from,
        effectiveTo: to,
      }),
    )

    /**
     * Nobody is holding it — the period is closed — so this is an ordinary handover and it has to
     * work. `assign` dated it `now()`, which is *behind* that close, so the new period overlapped a
     * finished one, the exclusion constraint refused it, and the person was told "somebody changed
     * who is holding this a moment before you did. Reload." Nobody had, and reloading changes
     * nothing: the handover is refused again every time, until the clock catches up.
     */
    const { asset, period } = await call(
      inv.custody.assign,
      { workspaceId: WS_CUSTODY, assetId: item.id, userId: BOB },
      ctx(),
    )
    expect(asset.custodianUserId).toBe(BOB)
    expect(
      new Date(period?.effectiveFrom ?? 0).getTime(),
      'the trail decides where the next period starts, not the clock',
    ).toBeGreaterThan(to.getTime())
  })
})

/**
 * Somebody who is not there.
 *
 * `custody.assign` and `custody.transfer` write a uuid into the two columns that answer "who is
 * answerable for this" for the rest of the item's life, and then send that person a notification.
 * Nothing looked the id up: any uuid was accepted, so a workspace could record a stranger — or a
 * typo — as holding company property, and the register would look entirely plausible, because every
 * screen renders an id it cannot resolve as "a former member".
 */
describe('handing an item to somebody who is not a member', () => {
  it('refuses the assignment, and writes nothing', async () => {
    const item = await createAsset(WS_CUSTODY, { name: 'Not going to a stranger' })
    const stranger = randomUUID()

    const code = await refusedWith(() =>
      call(
        inv.custody.assign,
        { workspaceId: WS_CUSTODY, assetId: item.id, userId: stranger },
        { context: asUser(ALICE, WS_CUSTODY) },
      ),
    )
    expect(code, 'naming somebody who is not there is a bad request, not a conflict').toBe('BAD_REQUEST')

    const periods = await call(
      inv.custody.history,
      { workspaceId: WS_CUSTODY, assetId: item.id },
      { context: asUser(ALICE, WS_CUSTODY) },
    )
    expect(periods, 'and no period was opened on the way to being refused').toEqual([])
    const after = await call(
      inv.assets.get,
      { workspaceId: WS_CUSTODY, assetId: item.id },
      { context: asUser(ALICE, WS_CUSTODY) },
    )
    expect({ status: after.status, holder: after.custodianUserId }).toEqual({
      status: 'in_stock',
      holder: null,
    })
  })

  it('refuses handing it on to one, and leaves it with whoever has it', async () => {
    const item = await createAsset(WS_CUSTODY, { name: 'Staying with Bob' })
    await call(
      inv.custody.assign,
      { workspaceId: WS_CUSTODY, assetId: item.id, userId: BOB },
      { context: asUser(ALICE, WS_CUSTODY) },
    )

    const code = await refusedWith(() =>
      call(
        inv.custody.transfer,
        { workspaceId: WS_CUSTODY, assetId: item.id, userId: randomUUID() },
        { context: asUser(ALICE, WS_CUSTODY) },
      ),
    )
    expect(code).toBe('BAD_REQUEST')

    const after = await call(
      inv.assets.get,
      { workspaceId: WS_CUSTODY, assetId: item.id },
      { context: asUser(ALICE, WS_CUSTODY) },
    )
    expect(after.custodianUserId, 'a refused handover does not release the person holding it').toBe(BOB)
  })

  it('tells a stranger nothing, because there was nothing to tell them about', async () => {
    const item = await createAsset(WS_CUSTODY, { name: 'No notification for a stranger' })
    const stranger = randomUUID()
    NOTIFICATIONS.length = 0
    await refusedWith(() =>
      call(
        inv.custody.assign,
        { workspaceId: WS_CUSTODY, assetId: item.id, userId: stranger },
        { context: asUser(ALICE, WS_CUSTODY) },
      ),
    )
    expect(NOTIFICATIONS.filter((n) => n.userId === stranger)).toEqual([])
  })
})

/**
 * Two transactions, one `assets.status`.
 *
 * `status` is stored rather than computed, and it is derived from two facts written by two different
 * services — who is holding the item, and whether a repair is open against it. Each service read the
 * *other's* fact without a lock, so the two derivations ran against snapshots taken before the other
 * had committed and the second write silently discarded the first. A plain lost update, and the
 * result is a status matching neither fact.
 *
 * Both tests drive the services through two transactions held open at once, which is the
 * interleaving a busy instance produces and a `Promise.all` on one event loop does not. Each step is
 * *waited for* rather than slept through: `waitForBlockedBackend` reads Postgres's own view of who
 * is queued, so which transaction wins is decided by the test rather than by machine load.
 */
describe('a handover and a repair at the same instant', () => {
  it('does not report an item as back in the office while it is at the workshop', async () => {
    const svc = inventoryServices(kernel)
    const item = await createAsset(WS_CUSTODY, { name: 'Assigned as it left for the workshop' })

    let repairWritten!: () => void
    const written = new Promise<void>((resolve) => {
      repairWritten = resolve
    })
    let commitRepair!: () => void
    const holdRepair = new Promise<void>((resolve) => {
      commitRepair = resolve
    })

    const sending = kernel.database.withWorkspace(
      WS_CUSTODY,
      async (tx) => {
        await svc.repairs.create(tx, WS_CUSTODY, ALICE, item.id, { summary: 'Cracked screen' })
        repairWritten()
        await holdRepair
      },
      { userId: ALICE },
    )
    await written

    // The handover reads "no repair is open" — the insert above is uncommitted, so it genuinely is
    // invisible — and used to write `assigned` over the `under_repair` the repair had just decided.
    const handing = kernel.database.withWorkspace(
      WS_CUSTODY,
      (tx) => svc.custody.assign(tx, WS_CUSTODY, ALICE, item.id, BOB, null, RECORDS_REPAIRS),
      { userId: ALICE },
    )
    const handed = handing.then(
      () => null,
      (err: unknown) => err,
    )

    await waitForBlockedBackend()
    commitRepair()
    await sending
    expect(await handed, 'a repair never refuses a handover; this one is legitimate').toBeNull()

    const after = await call(
      inv.assets.get,
      { workspaceId: WS_CUSTODY, assetId: item.id },
      { context: asUser(ALICE, WS_CUSTODY) },
    )
    // Both facts are true at once, and the status is the one that answers *where is it*.
    expect({ status: after.status, holder: after.custodianUserId }).toEqual({
      status: 'under_repair',
      holder: BOB,
    })
  })

  it('does not leave an item under repair after the repair it was under has been logged back', async () => {
    const svc = inventoryServices(kernel)
    const item = await createAsset(WS_CUSTODY, { name: 'Came back as it was handed back' })
    await call(
      inv.custody.assign,
      { workspaceId: WS_CUSTODY, assetId: item.id, userId: BOB },
      { context: asUser(ALICE, WS_CUSTODY) },
    )
    const { repair } = await call(
      inv.repairs.create,
      { workspaceId: WS_CUSTODY, assetId: item.id, summary: 'Hinge' },
      { context: asUser(ALICE, WS_CUSTODY) },
    )

    let completed!: () => void
    const done = new Promise<void>((resolve) => {
      completed = resolve
    })
    let commitComplete!: () => void
    const holdComplete = new Promise<void>((resolve) => {
      commitComplete = resolve
    })

    const finishing = kernel.database.withWorkspace(
      WS_CUSTODY,
      async (tx) => {
        await svc.repairs.complete(tx, WS_CUSTODY, ALICE, repair.id, {})
        completed()
        await holdComplete
      },
      { userId: ALICE },
    )
    await done

    // The return reads "a repair is open" — the completion above is uncommitted — and used to write
    // `under_repair` on an item that had just come home, with nobody holding it either.
    const taking = kernel.database.withWorkspace(
      WS_CUSTODY,
      (tx) => svc.custody.return(tx, WS_CUSTODY, ALICE, item.id, null, RECORDS_REPAIRS),
      { userId: ALICE },
    )
    const taken = taking.then(
      () => null,
      (err: unknown) => err,
    )

    await waitForBlockedBackend()
    commitComplete()
    await finishing
    expect(await taken).toBeNull()

    const after = await call(
      inv.assets.get,
      { workspaceId: WS_CUSTODY, assetId: item.id },
      { context: asUser(ALICE, WS_CUSTODY) },
    )
    expect({ status: after.status, holder: after.custodianUserId }).toEqual({
      status: 'in_stock',
      holder: null,
    })
  })
})

/**
 * Archiving, against the two things it says are impossible.
 *
 * `assets.archive` refuses to retire an item somebody is holding or one that is away for repair, and
 * both refusals used to read their fact with a plain select — so doing the two things at once
 * reached exactly the state the refusal calls impossible: an archived asset with a custody period
 * that never ends, which "what is Ada still holding?" stops counting because that question excludes
 * archived rows. A check whose answer another transaction may already have changed is not a check.
 */
describe('archiving an item somebody is reaching for', () => {
  it('refuses once the handover it raced has committed', async () => {
    const svc = inventoryServices(kernel)
    const item = await createAsset(WS_CUSTODY, { name: 'Archived out from under Bob' })

    let handed!: () => void
    const done = new Promise<void>((resolve) => {
      handed = resolve
    })
    let commitHandover!: () => void
    const holdHandover = new Promise<void>((resolve) => {
      commitHandover = resolve
    })

    const handing = kernel.database.withWorkspace(
      WS_CUSTODY,
      async (tx) => {
        await svc.custody.assign(tx, WS_CUSTODY, ALICE, item.id, BOB, null, RECORDS_REPAIRS)
        handed()
        await holdHandover
      },
      { userId: ALICE },
    )
    await done

    const archiving = kernel.database.withWorkspace(
      WS_CUSTODY,
      (tx) => svc.assets.archive(tx, WS_CUSTODY, ALICE, item.id, true, RECORDS_REPAIRS),
      { userId: ALICE },
    )
    const archived = archiving.then(
      () => null,
      (err: unknown) => err,
    )

    await waitForBlockedBackend()
    commitHandover()
    await handing

    const refusal = await archived
    expect(refusal, 'the archive must lose: Bob is holding it by the time it decides').not.toBeNull()
    expect(codeOf(refusal)).toBe('CONFLICT')
    expect(messageOf(refusal)).toMatch(/still holding/i)

    const after = await call(
      inv.assets.get,
      { workspaceId: WS_CUSTODY, assetId: item.id },
      { context: asUser(ALICE, WS_CUSTODY) },
    )
    expect({ archivedAt: after.archivedAt, holder: after.custodianUserId }).toEqual({
      archivedAt: null,
      holder: BOB,
    })
  })

  it('makes the handover it raced lose when the archive got there first', async () => {
    const svc = inventoryServices(kernel)
    const item = await createAsset(WS_CUSTODY, { name: 'Handed over as it was retired' })

    let retired!: () => void
    const done = new Promise<void>((resolve) => {
      retired = resolve
    })
    let commitArchive!: () => void
    const holdArchive = new Promise<void>((resolve) => {
      commitArchive = resolve
    })

    const archiving = kernel.database.withWorkspace(
      WS_CUSTODY,
      async (tx) => {
        await svc.assets.archive(tx, WS_CUSTODY, ALICE, item.id, true, RECORDS_REPAIRS)
        retired()
        await holdArchive
      },
      { userId: ALICE },
    )
    await done

    // The handover reads an asset that is not archived yet — it genuinely is not, from here — and
    // used to insert its period and stamp the columns over the top of the archive.
    const handing = kernel.database.withWorkspace(
      WS_CUSTODY,
      (tx) => svc.custody.assign(tx, WS_CUSTODY, ALICE, item.id, BOB, null, RECORDS_REPAIRS),
      { userId: ALICE },
    )
    const handed = handing.then(
      () => null,
      (err: unknown) => err,
    )

    await waitForBlockedBackend()
    commitArchive()
    await archiving

    const refusal = await handed
    expect(refusal, 'the handover must lose: the item left the register before it got there').not.toBeNull()
    expect(codeOf(refusal)).toBe('CONFLICT')
    expect(messageOf(refusal)).toMatch(/archived/i)

    // And the rolled-back transaction took its period with it, which is the state the refusal exists
    // to prevent: an archived asset nobody can find out is still in somebody's bag.
    const periods = await call(
      inv.custody.history,
      { workspaceId: WS_CUSTODY, assetId: item.id },
      { context: asUser(ALICE, WS_CUSTODY) },
    )
    expect(periods).toEqual([])
  })
})

/**
 * Reading the history back.
 *
 * The rows have been written since 0.2.0 and nothing could read them — a trail nobody can see is a
 * table, not a feature. The paging is the same keyset discipline `assets.list` uses and the same
 * cursor codec, because a second bookmark format would be a second set of the three bugs the first
 * one had.
 */
describe('reading an asset’s timeline', () => {
  // Lazy, for the reason spelled out above: a describe body runs before `beforeAll`.
  const ctx = () => ({ context: asUser(ALICE) })

  it('comes back newest first', async () => {
    const item = await createAsset(WS_A, { name: 'Trail' })
    await call(inv.assets.update, { workspaceId: WS_A, assetId: item.id, location: 'Desk 1' }, ctx())
    await call(inv.assets.update, { workspaceId: WS_A, assetId: item.id, location: 'Desk 2' }, ctx())
    const { items } = await call(inv.assets.history, { workspaceId: WS_A, assetId: item.id }, ctx())
    expect(items.map((e) => e.action)).toEqual(['updated', 'updated', 'created'])
    expect(items[0]?.changes).toEqual([{ field: 'location', from: 'Desk 1', to: 'Desk 2' }])
  })

  it('pages by id, so two entries written in one transaction cannot straddle a boundary', async () => {
    /**
     * `create` writes the asset and its `created` entry in one transaction, so `now()` is the same
     * for both — and any ordering by `occurred_at` would have no order between two entries that
     * share it. Ordering by the id, which is a uuidv7 and therefore already the clock, is unique.
     */
    const item = await createAsset(WS_A, { name: 'Paged trail' })
    for (let i = 0; i < 5; i++)
      await call(inv.assets.update, { workspaceId: WS_A, assetId: item.id, location: `Desk ${i}` }, ctx())

    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 10; guard++) {
      const page = await call(
        inv.assets.history,
        { workspaceId: WS_A, assetId: item.id, limit: 2, ...(cursor ? { cursor } : {}) },
        ctx(),
      )
      seen.push(...page.items.map((e) => e.id))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(seen, 'one create plus five updates').toHaveLength(6)
    expect(new Set(seen).size, 'no entry repeated across a page boundary').toBe(seen.length)
    expect([...seen].sort().reverse(), 'and still newest first end to end').toEqual(seen)
  })

  it('issues a cursor the contract can carry', async () => {
    const item = await createAsset(WS_A, { name: 'Cursor size' })
    await call(inv.assets.update, { workspaceId: WS_A, assetId: item.id, location: 'Anywhere' }, ctx())
    const page = await call(inv.assets.history, { workspaceId: WS_A, assetId: item.id, limit: 1 }, ctx())
    expect(page.nextCursor).toBeTruthy()
    expect(() => Cursor.parse(page.nextCursor)).not.toThrow()
  })

  it('refuses a marker it did not issue rather than handing it to Postgres', async () => {
    const item = await createAsset(WS_A, { name: 'Bad marker' })
    expect(
      await refusedWith(() =>
        call(
          inv.assets.history,
          {
            workspaceId: WS_A,
            assetId: item.id,
            cursor: Buffer.from('{"i":"nope","s":"recent"}').toString('base64url'),
          },
          ctx(),
        ),
      ),
    ).toBe('BAD_REQUEST')
  })

  it('answers "not yours" rather than an empty timeline', async () => {
    const mine = await createAsset(WS_A, { name: 'Private trail' })
    expect(
      await refusedWith(() =>
        call(inv.assets.history, { workspaceId: WS_B, assetId: mine.id }, { context: asUser(BOB, WS_B) }),
      ),
    ).toBe('NOT_FOUND')
  })
})

/**
 * Categories, and the filter that had nothing to filter by.
 *
 * `assets.list` has taken a `categoryId` since the module existed and nothing could create one, so
 * the filter had exactly one possible answer. Nothing here deletes: `assets.category_id` carries no
 * foreign key, so a delete would leave every asset filed under it pointing at a row that is not
 * there — a blank column, and a timeline entry that loses the name it recorded.
 */
describe('categories', () => {
  // Lazy, for the reason spelled out above: a describe body runs before `beforeAll`.
  const ctx = () => ({ context: asUser(ALICE, WS_CAT) })
  const create = (name: string) => call(inv.categories.create, { workspaceId: WS_CAT, name }, ctx())
  const list = (archived = false) => call(inv.categories.list, { workspaceId: WS_CAT, archived }, ctx())

  /**
   * Every new category joins the end, so the list reads back in the order somebody typed it.
   *
   * It used to take an optional `order` that defaulted to **0**, which meant every category anybody
   * added landed at the front tied with everything else, and `list`'s name tiebreak decided where —
   * so adding "Consumables" to an arranged list dropped it between "Cameras" and "Furniture". The
   * position is the statement's own business now (`coalesce(max(order), -1) + 1`), and no two live
   * categories share one.
   */
  it('appends each new category, so the list reads back in the order it was typed', async () => {
    await create('Furniture')
    await create('Cameras')
    await create('Laptops')
    await create('Consumables')
    const rows = await list()
    expect(rows.map((c) => c.name)).toEqual(['Furniture', 'Cameras', 'Laptops', 'Consumables'])
    expect(new Set(rows.map((c) => c.order)).size, 'and no two of them share a place').toBe(rows.length)
  })

  it('refuses a duplicate name with a sentence naming it, not a 500', async () => {
    await expect(create('Furniture')).rejects.toSatisfy(
      (err: unknown) => codeOf(err) === 'CONFLICT' && messageOf(err).includes('Furniture'),
    )
  })

  it('renames without disturbing anything else', async () => {
    const made = await create('Toolz')
    const renamed = await call(
      inv.categories.update,
      { workspaceId: WS_CAT, categoryId: made.id, name: 'Tools' },
      ctx(),
    )
    expect(renamed.name).toBe('Tools')
    expect(renamed.order).toBe(made.order)
  })

  it('archives and restores, and never deletes', async () => {
    const made = await create('Seasonal')
    const archived = await call(
      inv.categories.archive,
      { workspaceId: WS_CAT, categoryId: made.id, archived: true },
      ctx(),
    )
    expect(archived.archivedAt).toBeTruthy()
    expect(
      (await list()).map((c) => c.id),
      'gone from the picker',
    ).not.toContain(made.id)
    expect(
      (await list(true)).map((c) => c.id),
      'and still there',
    ).toContain(made.id)

    const back = await call(
      inv.categories.archive,
      { workspaceId: WS_CAT, categoryId: made.id, archived: false },
      ctx(),
    )
    expect(back.archivedAt).toBeNull()
  })

  it('leaves an asset filed under an archived category still naming it', async () => {
    // The whole reason this archives rather than deletes: the row goes on being able to say what
    // it is, and the timeline entry that recorded the move keeps the name it recorded.
    const made = await create('Retired kit')
    const item = await createAsset(WS_CAT, { name: 'Old switch', categoryId: made.id })
    await call(inv.categories.archive, { workspaceId: WS_CAT, categoryId: made.id, archived: true }, ctx())
    const after = await call(inv.assets.get, { workspaceId: WS_CAT, assetId: item.id }, ctx())
    expect(after.categoryId).toBe(made.id)
  })

  it('makes the asset list’s category filter mean something', async () => {
    const laptops = (await list(true)).find((c) => c.name === 'Laptops')
    expect(laptops).toBeTruthy()
    const filed = await createAsset(WS_CAT, { name: 'ThinkPad', categoryId: laptops?.id })
    await createAsset(WS_CAT, { name: 'Unfiled kettle' })
    const narrowed = await listAssets(WS_CAT, { categoryId: laptops?.id }, ALICE)
    expect(narrowed.items.map((a) => a.id)).toEqual([filed.id])
  })

  it('does not let one workspace see another’s categories', async () => {
    const mine = await create('Only ours')
    const theirs = await call(
      inv.categories.list,
      { workspaceId: WS_B, archived: true },
      { context: asUser(BOB, WS_B) },
    )
    expect(theirs.map((c) => c.id)).not.toContain(mine.id)
  })

  it('reports a category from another workspace as missing rather than editing it', async () => {
    const mine = await create('Untouchable')
    expect(
      await refusedWith(() =>
        call(
          inv.categories.update,
          { workspaceId: WS_B, categoryId: mine.id, name: 'Stolen' },
          { context: asUser(BOB, WS_B) },
        ),
      ),
    ).toBe('NOT_FOUND')
  })

  /**
   * What a change event *says*, which nothing could assert on before.
   *
   * `update` and `archive` announced a second change as `entity: 'asset'` carrying the category's
   * id — a row that does not exist, described to every subscriber and to every other service. It
   * looked harmless because the client's blunt `['inventory', 'asset']` invalidation fires on any
   * asset change whatever the id, so the screens refreshed anyway; the id-scoped invalidation beside
   * it matched nothing, and anything that acted on `{entity, id}` acted on a fiction.
   *
   * Nothing replaced it, because nothing needs to: a category's name is resolved on the client from
   * the categories query itself, and archiving one leaves `assets.category_id` exactly where it was.
   */
  it('announces the row that changed, and never an asset id that is not one', async () => {
    const row = await create('Announced correctly')

    CHANGES.length = 0
    await call(inv.categories.update, { workspaceId: WS_CAT, categoryId: row.id, name: 'Renamed' }, ctx())
    expect(CHANGES.map((c) => ({ entity: c.entity, id: c.id, op: c.op }))).toEqual([
      { entity: 'category', id: row.id, op: 'updated' },
    ])

    CHANGES.length = 0
    await call(inv.categories.archive, { workspaceId: WS_CAT, categoryId: row.id, archived: true }, ctx())
    expect(CHANGES.map((c) => ({ entity: c.entity, id: c.id, op: c.op }))).toEqual([
      { entity: 'category', id: row.id, op: 'updated' },
    ])

    CHANGES.length = 0
    await create('Also announced correctly')
    expect(CHANGES.map((c) => c.entity)).toEqual(['category'])
  })
})

/**
 * Putting the categories in order — the one procedure that writes `order`, and the four ways it
 * refuses.
 *
 * The settings page used to ask an administrator to type a **position number**, with a hint
 * explaining that lower comes first and that two categories sharing a number fall back to their
 * names. It is a list somebody drags now, and a drag produces a sequence of ids rather than an
 * arithmetic problem — so the contract takes the ids and the server renumbers the live set `0…n-1`
 * inside one transaction.
 *
 * Every refusal below exists because the alternative is a silent wrong answer. A list that leaves a
 * category out is not an instruction to leave it alone: it is an ordering of a workspace that no
 * longer exists, and completing it would drop the missing category wherever its stale number
 * happened to land, without telling anybody. The client's answer to the conflict is to reload and
 * ask again, which is why the reason token is asserted and not just the code — that token is the
 * only part of a refusal a Persian reader ever sees translated.
 */
describe('putting the categories in order', () => {
  const ctx = () => ({ context: asUser(ALICE, WS_ORDER) })
  const create = (name: string) => call(inv.categories.create, { workspaceId: WS_ORDER, name }, ctx())
  const list = (archived = false) => call(inv.categories.list, { workspaceId: WS_ORDER, archived }, ctx())
  const reorder = (categoryIds: string[]) =>
    call(inv.categories.reorder, { workspaceId: WS_ORDER, categoryIds }, ctx())
  const names = async () => (await list()).map((c) => c.name)

  it('renumbers the whole sequence from the ids it was handed', async () => {
    await create('Desks')
    await create('Chairs')
    await create('Lamps')
    expect(await names(), 'appended, so this is the order they were typed in').toEqual([
      'Desks',
      'Chairs',
      'Lamps',
    ])

    const ids = (await list()).map((c) => c.id)
    const answered = await reorder([ids[2] as string, ids[0] as string, ids[1] as string])
    expect(answered.map((c) => c.name)).toEqual(['Lamps', 'Desks', 'Chairs'])
    expect(
      answered.map((c) => c.order),
      'contiguous from zero, with no ties left behind',
    ).toEqual([0, 1, 2])
    expect(await names(), 'and the next read agrees').toEqual(['Lamps', 'Desks', 'Chairs'])
  })

  it('refuses a list naming a category from another workspace, and writes nothing', async () => {
    const theirs = await call(
      inv.categories.create,
      { workspaceId: WS_B, name: 'Not ours to order' },
      { context: asUser(BOB, WS_B) },
    )
    const ids = (await list()).map((c) => c.id)
    // Permuted as well as poisoned: if the renumbering ran before the check, the order would move.
    expect(
      await refusedWith(() => reorder([ids[1] as string, ids[0] as string, ids[2] as string, theirs.id])),
      'a category this workspace does not have is missing, not forbidden',
    ).toBe('NOT_FOUND')
    expect(await names(), 'nothing was written').toEqual(['Lamps', 'Desks', 'Chairs'])

    // And the other workspace's own category was not renumbered on the way past.
    const theirsAfter = await call(
      inv.categories.list,
      { workspaceId: WS_B, archived: true },
      { context: asUser(BOB, WS_B) },
    )
    expect(theirsAfter.find((c) => c.id === theirs.id)?.order).toBe(theirs.order)
  })

  it('refuses a list that leaves out a category added while the page was open', async () => {
    const ids = (await list()).map((c) => c.id)
    // The other tab.
    await create('Shelves')

    const attempt = () => reorder([ids[1] as string, ids[0] as string, ids[2] as string])
    expect(await refusedWith(attempt)).toBe('CONFLICT')
    await expect(attempt()).rejects.toSatisfy(
      (err: unknown) => reasonOf(err) === 'inventory.category.order_stale',
    )
    expect(
      await names(),
      'refused whole: renumbering three of four would have moved Shelves nowhere anybody chose',
    ).toEqual(['Lamps', 'Desks', 'Chairs', 'Shelves'])
  })

  it('refuses a list naming a category archived while the page was open', async () => {
    const ids = (await list()).map((c) => c.id)
    const shelves = ids[3] as string
    await call(inv.categories.archive, { workspaceId: WS_ORDER, categoryId: shelves, archived: true }, ctx())

    await expect(reorder([...ids].reverse())).rejects.toSatisfy(
      (err: unknown) => codeOf(err) === 'CONFLICT' && reasonOf(err) === 'inventory.category.order_stale',
    )
    expect(await names()).toEqual(['Lamps', 'Desks', 'Chairs'])

    // Restored, it joins the end rather than landing back on the number it left with — which, after
    // three renumberings, belongs to somebody else.
    await call(inv.categories.archive, { workspaceId: WS_ORDER, categoryId: shelves, archived: false }, ctx())
    const back = await list()
    expect(back.map((c) => c.name)).toEqual(['Lamps', 'Desks', 'Chairs', 'Shelves'])
    expect(new Set(back.map((c) => c.order)).size).toBe(back.length)
  })

  it('refuses a list that names the same category twice', async () => {
    const ids = (await list()).map((c) => c.id)
    expect(await refusedWith(() => reorder([ids[0] as string, ...ids]))).toBe('BAD_REQUEST')
    expect(await names()).toEqual(['Lamps', 'Desks', 'Chairs', 'Shelves'])
  })

  it('announces the rows that moved, and stays silent about the ones that did not', async () => {
    const ids = (await list()).map((c) => c.id)
    const swapped = [ids[0] as string, ids[1] as string, ids[3] as string, ids[2] as string]

    CHANGES.length = 0
    await reorder(swapped)
    expect(new Set(CHANGES.map((c) => c.entity)), 'a category changed, not an asset').toEqual(
      new Set(['category']),
    )
    expect(
      CHANGES.map((c) => c.id).sort(),
      'only the two that swapped — telling every open screen about the other two would describe a write nobody performed',
    ).toEqual([ids[2] as string, ids[3] as string].sort())

    CHANGES.length = 0
    await reorder(swapped)
    expect(CHANGES, 'the same order again moves nothing and announces nothing').toEqual([])
  })

  /**
   * Two reorders arriving at once, driven through two transactions held open rather than raced for.
   *
   * A `Promise.all` on one event loop usually serialises on a laptop and proves nothing; this is the
   * interleaving a busy instance produces. B is only released once Postgres says it is *waiting on a
   * lock*, which is the honest signal that its `select … for update` has queued behind A rather than
   * having run before it.
   *
   * The `for update` is the whole subject. Without it both transactions read the same list, both
   * pass the completeness check, and their per-row updates land interleaved — leaving a sequence
   * that is neither of the two orders anybody asked for, with two categories on the same number.
   * With it, the second one waits, re-reads what the first committed and writes its own ordering on
   * top: last in wins, whole.
   */
  it('lets two reorders arriving at once settle one after the other, never half of each', async () => {
    const svc = inventoryServices(kernel)
    const ids = (await list()).map((c) => c.id)
    const first = [...ids].reverse()
    const second = [ids[2] as string, ids[0] as string, ids[3] as string, ids[1] as string]

    let aHasLocked!: () => void
    const locked = new Promise<void>((resolve) => {
      aHasLocked = resolve
    })
    let commitA!: () => void
    const holdA = new Promise<void>((resolve) => {
      commitA = resolve
    })

    const a = kernel.database.withWorkspace(
      WS_ORDER,
      async (tx) => {
        await svc.categories.reorder(tx, WS_ORDER, first)
        aHasLocked()
        await holdA
      },
      { userId: ALICE },
    )
    await locked

    const b = kernel.database.withWorkspace(WS_ORDER, (tx) => svc.categories.reorder(tx, WS_ORDER, second), {
      userId: BOB,
    })
    // Attached now, so a rejection is never an unhandled one while the poll below runs.
    const bSettled = b.then(
      () => null,
      (err: unknown) => err,
    )

    await waitForBlockedBackend()
    commitA()
    await a
    expect(await bSettled, 'both orderings are valid; the second simply waits its turn').toBeNull()

    const after = await list()
    expect(
      after.map((c) => c.id),
      'the last one in wins, and wins whole',
    ).toEqual(second)
    expect(after.map((c) => c.order)).toEqual([0, 1, 2, 3])
  })
})

/**
 * The claim that no two live categories share a place, held to by the database rather than by care.
 *
 * The contract said it, the changeset said it and `list`'s own comment said it — and all three were
 * describing an intention. A category joins the end of the list by taking
 * `(select coalesce(max("order"), -1) + 1)`, and a restore appends the same way; putting that
 * subquery *inside* the write removes a round trip and removes no race at all. Under READ COMMITTED
 * each statement takes its own snapshot, so two transactions appending at the same instant both read
 * a list without the other's row in it and both take the same number. `reorder`'s `select … for
 * update` serialises neither of them: a row lock cannot cover a row that does not exist yet.
 *
 * Measured before the fix, against this exact block: three live categories on two distinct numbers
 * after two creates, and five on three after a create raced a restore.
 *
 * Two things make the sentence true now, and they answer different questions. The **advisory lock**
 * per workspace is what makes the ordinary append correct — the second caller waits, re-reads and
 * takes the next number, so nobody is refused for pressing a button at an unlucky moment. The
 * **partial unique index** is what makes the claim hold whatever else ever reaches the table.
 */
describe('two live categories can never share a place', () => {
  const ctx = () => ({ context: asUser(ALICE, WS_UNIQUE) })
  const create = (name: string) => call(inv.categories.create, { workspaceId: WS_UNIQUE, name }, ctx())
  const live = () => call(inv.categories.list, { workspaceId: WS_UNIQUE, archived: false }, ctx())

  /**
   * Two appends driven through two transactions held open, rather than raced for.
   *
   * A `Promise.all` on one event loop usually serialises on a laptop and proves nothing. B is only
   * released once Postgres says a backend is *waiting on a lock*, which is the honest signal that it
   * has queued behind A rather than having run before it — the same shape as the two-reorder test
   * above, and the reason this cannot pass by luck.
   */
  async function bothAppendAtOnce(firstName: string, second: (tx: Tx) => Promise<unknown>) {
    const svc = inventoryServices(kernel)
    let aHasWritten!: () => void
    const written = new Promise<void>((resolve) => {
      aHasWritten = resolve
    })
    let commitA!: () => void
    const holdA = new Promise<void>((resolve) => {
      commitA = resolve
    })

    const a = kernel.database.withWorkspace(
      WS_UNIQUE,
      async (tx) => {
        const row = await svc.categories.create(tx, WS_UNIQUE, firstName)
        aHasWritten()
        await holdA
        return row
      },
      { userId: ALICE },
    )
    await written

    const b = kernel.database.withWorkspace(WS_UNIQUE, second, { userId: BOB })
    // Attached now, so a rejection is never an unhandled one while the poll below runs.
    const bSettled = b.then(
      () => null,
      (err: unknown) => err,
    )

    await waitForBlockedBackend()
    commitA()
    await a
    return bSettled
  }

  it('gives two creates that append at the same instant two different places', async () => {
    await create('Already here')
    const svc = inventoryServices(kernel)

    const refusal = await bothAppendAtOnce('Raced in first', (tx) =>
      svc.categories.create(tx, WS_UNIQUE, 'Raced in second'),
    )
    expect(refusal, 'the second waits for the first and then appends properly — nobody is refused').toBeNull()

    const rows = await live()
    expect(new Set(rows.map((c) => c.order)).size, 'every live place is its own').toBe(rows.length)
    expect(rows.map((c) => c.name)).toEqual(['Already here', 'Raced in first', 'Raced in second'])
  })

  it('gives a restore racing a create the place after it, not the same one', async () => {
    const parked = await create('Archived, and coming back')
    await call(
      inv.categories.archive,
      { workspaceId: WS_UNIQUE, categoryId: parked.id, archived: true },
      ctx(),
    )
    const svc = inventoryServices(kernel)

    // A restore appends exactly as a create does, and used to read the same stale maximum.
    const refusal = await bothAppendAtOnce('Raced past a restore', (tx) =>
      svc.categories.archive(tx, WS_UNIQUE, parked.id, false),
    )
    expect(refusal, 'a restore appends too, and waits its turn the same way').toBeNull()

    const rows = await live()
    expect(new Set(rows.map((c) => c.order)).size, 'every live place is its own').toBe(rows.length)
    expect(rows.at(-1)?.name, 'the restore came last, so it is last').toBe('Archived, and coming back')
  })

  /**
   * The index itself, asked directly — because the lock above is what keeps the ordinary path off it,
   * and a guard nothing ever reaches is a guard nobody can tell is missing.
   */
  it('refuses two live rows on one number, whatever writes them', async () => {
    const rows = await live()
    const first = rows[0]!
    const second = rows[1]!
    const name = await constraintViolated(() =>
      kernel.database.withWorkspace(
        WS_UNIQUE,
        (tx) =>
          tx
            .update(categoriesTable)
            .set({ order: first.order })
            .where(and(eq(categoriesTable.workspaceId, WS_UNIQUE), eq(categoriesTable.id, second.id))),
        { userId: ALICE },
      ),
    )
    expect(name).toBe('inventory_categories_ws_order_live_uq')
  })

  /**
   * And the index is *partial*, which is the half a total unique index would get wrong: an archived
   * row keeps the number it had when it left, and a live row is renumbered onto it by the very next
   * reorder. That is not a collision anybody can see — an archived category is in no picker, no
   * filter and no sequence — so the index must not refuse it.
   */
  it('lets an archived category keep a number a live one now holds', async () => {
    const rows = await live()
    const first = rows[0]
    expect(first, 'the block above left at least one live category').toBeDefined()
    await call(
      inv.categories.archive,
      { workspaceId: WS_UNIQUE, categoryId: first!.id, archived: true },
      ctx(),
    )

    const remaining = (await live()).map((c) => c.id)
    await call(inv.categories.reorder, { workspaceId: WS_UNIQUE, categoryIds: remaining }, ctx())

    const all = await call(inv.categories.list, { workspaceId: WS_UNIQUE, archived: true }, ctx())
    const archivedRow = all.find((c) => c.id === first!.id)
    expect(archivedRow?.archivedAt, 'still archived').not.toBeNull()
    const stillLive = all.filter((c) => !c.archivedAt)
    expect(
      stillLive.map((c) => c.order),
      'renumbered from zero, and free to reuse the number the archived row is sitting on',
    ).toEqual(stillLive.map((_c, i) => i))
    expect(
      stillLive.some((c) => c.order === archivedRow?.order),
      'a live row really is sitting on the archived one’s number',
    ).toBe(true)
  })

  /**
   * A swap is the commonest reorder there is, and it is the one a plain unique index refuses.
   *
   * Postgres checks a unique *index* row by row rather than at the end of the statement, and there is
   * no deferrable form to reach for — a unique constraint can be deferred and cannot be partial. So
   * `reorder` parks every moving row above the sequence first and puts them down afterwards. Without
   * that, this test is a 23505 during an entirely ordinary drag.
   */
  it('swaps two neighbours without ever colliding on the way', async () => {
    const before = (await live()).map((c) => c.id)
    expect(before.length, 'a swap needs two').toBeGreaterThan(1)
    const swapped = [before[1]!, before[0]!, ...before.slice(2)]

    const answered = await call(
      inv.categories.reorder,
      { workspaceId: WS_UNIQUE, categoryIds: swapped },
      ctx(),
    )
    expect(answered.map((c) => c.id)).toEqual(swapped)
    expect(answered.map((c) => c.order)).toEqual(swapped.map((_id, i) => i))
  })

  /**
   * And the whole sequence reversed, which parks and lands every row in the list at once.
   *
   * The parking values have to clear both the highest number any row holds *and* the last place in
   * the new sequence; a base that only cleared the first collides the moment a workspace's numbers
   * are sparser than its row count.
   */
  it('reverses the whole list in one call', async () => {
    const before = (await live()).map((c) => c.id)
    const reversed = [...before].reverse()

    const answered = await call(
      inv.categories.reorder,
      { workspaceId: WS_UNIQUE, categoryIds: reversed },
      ctx(),
    )
    expect(answered.map((c) => c.id)).toEqual(reversed)
    expect(answered.map((c) => c.order)).toEqual(reversed.map((_id, i) => i))
  })
})

/**
 * The ceiling, and the fact that it is stated somewhere rather than only implied.
 *
 * `categories.reorder` is handed every live category at once, so its input array carries a bound —
 * every zod array a client fills has to, or one request can ask the server to hold an arbitrary list.
 * A bound on the array *alone* is a silent ceiling: a workspace could pass it one category at a time,
 * because nothing else counted, and the first sign would be that the only procedure able to order
 * them refuses every call. Nothing on the screen would say why, and there is no other way to reorder.
 *
 * So the same constant is enforced where somebody meets it, at the moment they meet it, with a
 * sentence carrying the number. The two halves are asserted together below, because they are only
 * worth anything as a pair: the limit is reachable by creating, and a workspace sitting exactly on it
 * can still reorder every category it has.
 */
describe('the number of categories a workspace can keep', () => {
  const ctx = () => ({ context: asUser(ALICE, WS_LIMIT) })
  const create = (name: string) => call(inv.categories.create, { workspaceId: WS_LIMIT, name }, ctx())

  beforeAll(async () => {
    // Filled with one statement rather than 500 calls: what is under test is the count, not the path
    // that produced it, and 500 round trips through the router would dominate this file's runtime.
    await kernel.database.withWorkspace(
      WS_LIMIT,
      (tx) =>
        tx.execute(sql`
          insert into mod_inventory.categories (workspace_id, name, "order")
          select ${WS_LIMIT}::uuid, 'Filler ' || n, n - 1
            from generate_series(1, ${MAX_LIVE_CATEGORIES}) as n
        `),
      { userId: ALICE },
    )
  }, 60_000)

  it('refuses the one past it, and says what to do about it', async () => {
    const refusal = await capture(() => create('One too many'))
    expect(codeOf(refusal)).toBe('CONFLICT')
    expect(reasonOf(refusal), 'a token, because the sentence a Persian reader sees is the client’s own').toBe(
      'inventory.category.limit_reached',
    )
    expect(messageOf(refusal), 'and the server names the number rather than hinting at one').toContain(
      String(MAX_LIVE_CATEGORIES),
    )
  })

  it('still lets a workspace sitting on the limit order every category it has', async () => {
    // The whole point of holding the two to one number: the bound on the array is never the thing a
    // real workspace runs into first.
    const rows = await call(inv.categories.list, { workspaceId: WS_LIMIT, archived: false }, ctx())
    expect(rows).toHaveLength(MAX_LIVE_CATEGORIES)
    const reordered = [rows.at(-1)!.id, ...rows.slice(0, -1).map((c) => c.id)]
    const answered = await call(
      inv.categories.reorder,
      { workspaceId: WS_LIMIT, categoryIds: reordered },
      ctx(),
    )
    expect(answered.map((c) => c.id)).toEqual(reordered)
    expect(new Set(answered.map((c) => c.order)).size, 'and no two share a place').toBe(MAX_LIVE_CATEGORIES)
  })

  it('makes room when one is archived, which is what the refusal tells the reader to do', async () => {
    const rows = await call(inv.categories.list, { workspaceId: WS_LIMIT, archived: false }, ctx())
    await call(
      inv.categories.archive,
      { workspaceId: WS_LIMIT, categoryId: rows[0]!.id, archived: true },
      ctx(),
    )
    const added = await create('Fits now')
    expect(added.name).toBe('Fits now')

    // And the freed place cannot be taken twice: restoring the archived one is refused in turn.
    const refusal = await capture(() =>
      call(
        inv.categories.archive,
        { workspaceId: WS_LIMIT, categoryId: rows[0]!.id, archived: false },
        ctx(),
      ),
    )
    expect(reasonOf(refusal), 'a restore grows the live set too, so it is held to the same number').toBe(
      'inventory.category.limit_reached',
    )
  })
})

// ---------------------------------------------------------------------------------------------

const sendForRepair = (
  workspaceId: WorkspaceId,
  assetId: string,
  input: { summary: string; vendor?: string; costMinor?: number; currency?: string; sentOn?: string },
  userId = ALICE,
) => call(inv.repairs.create, { workspaceId, assetId, ...input }, { context: asUser(userId, workspaceId) })

const completeRepair = (
  workspaceId: WorkspaceId,
  repairId: string,
  input: { returnedOn?: string; costMinor?: number; currency?: string } = {},
  userId = ALICE,
) => call(inv.repairs.complete, { workspaceId, repairId, ...input }, { context: asUser(userId, workspaceId) })

const statusOf = async (workspaceId: WorkspaceId, assetId: string) =>
  (await call(inv.assets.get, { workspaceId, assetId }, { context: asUser(ALICE, workspaceId) })).status

/**
 * Repairs, and the rule that makes them more than another table: **a repair is not custody**.
 *
 * An item at a repairer is still whoever's it was. Everything below is one of the two halves of
 * that — the status moves and the custodian does not — or one of the refusals that keeps the two
 * counts of "what is away" from being able to disagree.
 */
describe('sending an item for repair', () => {
  const anAsset = (name: string) => createAsset(WS_REPAIR, { name })

  it('puts it under repair and leaves the custodian alone', async () => {
    const asset = await anAsset('Handed-out laptop')
    await call(
      inv.custody.assign,
      { workspaceId: WS_REPAIR, assetId: asset.id, userId: BOB },
      { context: asUser(ALICE, WS_REPAIR) },
    )
    const { asset: away } = await sendForRepair(WS_REPAIR, asset.id, { summary: 'Cracked screen' })
    // The half that is easy to get wrong: Bob is still answerable for it.
    expect({ status: away.status, holder: away.custodianUserId }).toEqual({
      status: 'under_repair',
      holder: BOB,
    })
  })

  it('gives it back to whoever still holds it, not to stock', async () => {
    const asset = await anAsset('Battery swap')
    await call(
      inv.custody.assign,
      { workspaceId: WS_REPAIR, assetId: asset.id, userId: BOB },
      { context: asUser(ALICE, WS_REPAIR) },
    )
    const { repair } = await sendForRepair(WS_REPAIR, asset.id, { summary: 'Battery' })
    const { asset: back } = await completeRepair(WS_REPAIR, repair.id)
    // Completing straight to `in_stock` would release Bob from something nobody decided to take
    // off him — silently, and only visible the next time somebody went looking for the laptop.
    expect({ status: back.status, holder: back.custodianUserId }).toEqual({
      status: 'assigned',
      holder: BOB,
    })
  })

  it('goes to stock when nobody was holding it', async () => {
    const asset = await anAsset('Spare monitor')
    const { repair } = await sendForRepair(WS_REPAIR, asset.id, { summary: 'Dead pixel' })
    const { asset: back } = await completeRepair(WS_REPAIR, repair.id)
    expect({ status: back.status, holder: back.custodianUserId }).toEqual({
      status: 'in_stock',
      holder: null,
    })
  })

  it('lets an item change hands while it is away, and keeps it under repair', async () => {
    const asset = await anAsset('Handed on mid-repair')
    await call(
      inv.custody.assign,
      { workspaceId: WS_REPAIR, assetId: asset.id, userId: ALICE },
      { context: asUser(ALICE, WS_REPAIR) },
    )
    const { repair } = await sendForRepair(WS_REPAIR, asset.id, { summary: 'Keyboard' })
    // Refusing custody during a repair would mean refusing `return` too, and somebody leaving the
    // company while their laptop is in a workshop has to be able to hand it back.
    const handed = await call(
      inv.custody.transfer,
      { workspaceId: WS_REPAIR, assetId: asset.id, userId: BOB },
      { context: asUser(ALICE, WS_REPAIR) },
    )
    expect({ status: handed.asset.status, holder: handed.asset.custodianUserId }).toEqual({
      status: 'under_repair',
      holder: BOB,
    })
    const taken = await call(
      inv.custody.return,
      { workspaceId: WS_REPAIR, assetId: asset.id },
      { context: asUser(ALICE, WS_REPAIR) },
    )
    // Nobody holds it and it is still at the repairer, which is exactly true.
    expect({ status: taken.asset.status, holder: taken.asset.custodianUserId }).toEqual({
      status: 'under_repair',
      holder: null,
    })
    await completeRepair(WS_REPAIR, repair.id)
    expect(await statusOf(WS_REPAIR, asset.id)).toBe('in_stock')
  })

  it('refuses a second repair while the first is open, with a sentence rather than a 500', async () => {
    const asset = await anAsset('Contested repair')
    await sendForRepair(WS_REPAIR, asset.id, { summary: 'First' })
    try {
      await sendForRepair(WS_REPAIR, asset.id, { summary: 'Second' })
      throw new Error('Expected the second repair to be refused')
    } catch (err) {
      expect(codeOf(err)).toBe('CONFLICT')
      expect(messageOf(err)).toContain('already away for repair')
    }
  })

  it('has the database refuse it too, not only the service', async () => {
    // The service reads before it inserts, so the check it makes is a race. The unique index is
    // what actually decides, and a test that only exercised the read would pass against a schema
    // with no index at all.
    const asset = await anAsset('Two at once')
    await inWs(WS_REPAIR)((tx) =>
      tx
        .insert(repairs)
        .values({ workspaceId: WS_REPAIR, assetId: asset.id, summary: 'A', sentOn: '2026-01-01' }),
    )
    const name = await constraintViolated(() =>
      inWs(WS_REPAIR)((tx) =>
        tx
          .insert(repairs)
          .values({ workspaceId: WS_REPAIR, assetId: asset.id, summary: 'B', sentOn: '2026-01-02' }),
      ),
    )
    expect(name).toBe('inventory_repairs_one_open_uq')
  })

  it('allows the next repair once the previous one is closed', async () => {
    // The other half: an index that refused this would make a second repair impossible, and a test
    // that only proves rejection cannot tell the two apart.
    const asset = await anAsset('Repeat offender')
    const { repair } = await sendForRepair(WS_REPAIR, asset.id, { summary: 'Once' })
    await completeRepair(WS_REPAIR, repair.id)
    const again = await sendForRepair(WS_REPAIR, asset.id, { summary: 'Twice' })
    expect(again.repair.returnedOn).toBeNull()
  })

  it('refuses completing the same repair twice', async () => {
    const asset = await anAsset('Finished once')
    const { repair } = await sendForRepair(WS_REPAIR, asset.id, { summary: 'Done' })
    await completeRepair(WS_REPAIR, repair.id)
    expect(await refusedWith(() => completeRepair(WS_REPAIR, repair.id))).toBe('CONFLICT')
  })

  it('refuses a return date before the send date', async () => {
    // Postgres has no opinion about this one, and stored it makes every "how long was it away"
    // answer negative for ever.
    const asset = await anAsset('Time traveller')
    const { repair } = await sendForRepair(WS_REPAIR, asset.id, {
      summary: 'Hinge',
      sentOn: '2026-06-01',
    })
    expect(await refusedWith(() => completeRepair(WS_REPAIR, repair.id, { returnedOn: '2026-05-31' }))).toBe(
      'CONFLICT',
    )
  })

  /**
   * The same invariant, from the other end — and the end nothing was checking.
   *
   * `complete` has refused a return date before the send date since it was written. `update` took
   * `sentOn` straight out of the patch, so correcting the send date of a repair that had *already
   * come back* could move it past the day it came back: a repair that ended before it started, with
   * nothing to say which of the two dates is the wrong one. Every "how long was it away" answer goes
   * negative, and the overdue sweep starts measuring from a date in the future.
   */
  it('refuses re-dating a finished repair to after it came back, and changes nothing', async () => {
    const asset = await anAsset('Invoice arrived a week later')
    const { repair } = await sendForRepair(WS_REPAIR, asset.id, {
      summary: 'Fan',
      sentOn: '2026-03-01',
    })
    await completeRepair(WS_REPAIR, repair.id, { returnedOn: '2026-03-10' })

    const code = await refusedWith(() =>
      call(
        inv.repairs.update,
        { workspaceId: WS_REPAIR, repairId: repair.id, sentOn: '2026-04-01' },
        { context: asUser(ALICE, WS_REPAIR) },
      ),
    )
    expect(code).toBe('CONFLICT')

    const [row] = await inWs(WS_REPAIR)((tx) =>
      tx
        .select({ sentOn: repairs.sentOn, returnedOn: repairs.returnedOn })
        .from(repairs)
        .where(eq(repairs.id, repair.id)),
    )
    expect(row, 'a refused edit leaves both dates exactly where they were').toEqual({
      sentOn: '2026-03-01',
      returnedOn: '2026-03-10',
    })
  })

  it('still allows re-dating one that is still away, and one that stays in order', async () => {
    // The other half: a check that refused these would make correcting a send date impossible, and a
    // test that only proves rejection cannot tell the two apart.
    const away = await anAsset('Still at the workshop')
    const open = await sendForRepair(WS_REPAIR, away.id, { summary: 'Screen', sentOn: '2026-03-01' })
    const moved = await call(
      inv.repairs.update,
      { workspaceId: WS_REPAIR, repairId: open.repair.id, sentOn: '2026-05-01' },
      { context: asUser(ALICE, WS_REPAIR) },
    )
    expect(moved.repair.sentOn).toBe('2026-05-01')

    const back = await anAsset('Home again')
    const finished = await sendForRepair(WS_REPAIR, back.id, { summary: 'Battery', sentOn: '2026-03-01' })
    await completeRepair(WS_REPAIR, finished.repair.id, { returnedOn: '2026-03-20' })
    const corrected = await call(
      inv.repairs.update,
      { workspaceId: WS_REPAIR, repairId: finished.repair.id, sentOn: '2026-03-05' },
      { context: asUser(ALICE, WS_REPAIR) },
    )
    expect(corrected.repair.sentOn).toBe('2026-03-05')
  })

  it('has the database refuse the pair too, not only the service', async () => {
    // The service checks first so an ordinary mistake gets a sentence — but two transactions can
    // each pass that check and still commit a pair that fails it, one moving `sent_on` while the
    // other logs the item back. The constraint is what makes the rule true of the table.
    const asset = await anAsset('Straight into the table')
    const name = await constraintViolated(() =>
      inWs(WS_REPAIR)((tx) =>
        tx.insert(repairs).values({
          workspaceId: WS_REPAIR,
          assetId: asset.id,
          summary: 'Written round the wrong way',
          sentOn: '2026-06-10',
          returnedOn: '2026-06-01',
        }),
      ),
    )
    expect(name).toBe('inventory_repairs_returned_after_sent')
  })

  it('refuses sending an archived item for repair', async () => {
    const asset = await anAsset('Retired thing')
    await call(
      inv.assets.archive,
      { workspaceId: WS_REPAIR, assetId: asset.id, archived: true },
      { context: asUser(ALICE, WS_REPAIR) },
    )
    expect(await refusedWith(() => sendForRepair(WS_REPAIR, asset.id, { summary: 'Too late' }))).toBe(
      'CONFLICT',
    )
  })

  it('refuses archiving something that is away for repair', async () => {
    // Which is what keeps `byStatus.under_repair` (live rows, cached column) and `outForRepair`
    // (repair rows) from being able to disagree.
    const asset = await anAsset('Still at the workshop')
    await sendForRepair(WS_REPAIR, asset.id, { summary: 'Screen' })
    const code = await refusedWith(() =>
      call(
        inv.assets.archive,
        { workspaceId: WS_REPAIR, assetId: asset.id, archived: true },
        { context: asUser(ALICE, WS_REPAIR) },
      ),
    )
    expect(code).toBe('CONFLICT')
  })

  it('inherits the asset’s currency for a cost that arrives without one', async () => {
    const asset = await createAsset(WS_REPAIR, { name: 'Priced in euros', currency: 'EUR' })
    const { repair } = await sendForRepair(WS_REPAIR, asset.id, { summary: 'Fan', costMinor: 4500 })
    // A number with no unit is not a cost.
    expect({ cost: repair.costMinor, currency: repair.currency }).toEqual({
      cost: 4500,
      currency: 'EUR',
    })
  })

  it('never inherits over a currency the repair already carries', async () => {
    // Recording an amount in dollars against an asset priced in euros must not quietly relabel it.
    const asset = await createAsset(WS_REPAIR, { name: 'Euro asset, dollar repair', currency: 'EUR' })
    const { repair } = await sendForRepair(WS_REPAIR, asset.id, {
      summary: 'Imported part',
      costMinor: 1000,
      currency: 'USD',
    })
    const raised = await call(
      inv.repairs.update,
      { workspaceId: WS_REPAIR, repairId: repair.id, costMinor: 2000 },
      { context: asUser(ALICE, WS_REPAIR) },
    )
    expect({ cost: raised.repair.costMinor, currency: raised.repair.currency }).toEqual({
      cost: 2000,
      currency: 'USD',
    })
  })

  it('does not give a cleared currency back on an unrelated edit', async () => {
    // The silent version of the same bug: inheriting whenever a cost *exists* rather than whenever
    // one *arrives* means correcting a vendor undoes somebody's deliberate `null`.
    const asset = await createAsset(WS_REPAIR, { name: 'No currency, please', currency: 'EUR' })
    const { repair } = await sendForRepair(WS_REPAIR, asset.id, { summary: 'Unpriced' })
    const cleared = await call(
      inv.repairs.update,
      { workspaceId: WS_REPAIR, repairId: repair.id, costMinor: 500, currency: null },
      { context: asUser(ALICE, WS_REPAIR) },
    )
    expect(cleared.repair.currency).toBeNull()
    const renamed = await call(
      inv.repairs.update,
      { workspaceId: WS_REPAIR, repairId: repair.id, vendor: 'Somebody' },
      { context: asUser(ALICE, WS_REPAIR) },
    )
    expect({ cost: renamed.repair.costMinor, currency: renamed.repair.currency }).toEqual({
      cost: 500,
      currency: null,
    })
  })

  it('records going away and coming back, and nothing for an edit', async () => {
    const asset = await anAsset('Timeline of a repair')
    const { repair } = await sendForRepair(WS_REPAIR, asset.id, { summary: 'Trackpad' })
    await call(
      inv.repairs.update,
      { workspaceId: WS_REPAIR, repairId: repair.id, vendor: 'Somebody else' },
      { context: asUser(ALICE, WS_REPAIR) },
    )
    await completeRepair(WS_REPAIR, repair.id, { costMinor: 9900, currency: 'EUR' })
    const { items } = await call(
      inv.assets.history,
      { workspaceId: WS_REPAIR, assetId: asset.id },
      { context: asUser(ALICE, WS_REPAIR) },
    )
    // Correcting a vendor did not happen *to the asset*; the two entries that matter are not
    // buried under the paperwork around them.
    expect(items.map((e) => e.action)).toEqual(['repair_completed', 'repair_logged', 'created'])
    expect(items[1]?.data).toMatchObject({ repairId: repair.id, summary: 'Trackpad' })
  })

  it('leaves the return date to `complete`, whatever a patch asks for', async () => {
    const asset = await anAsset('Not patchable')
    const { repair } = await sendForRepair(WS_REPAIR, asset.id, { summary: 'Case' })
    await call(
      inv.repairs.update,
      { workspaceId: WS_REPAIR, repairId: repair.id, summary: 'Case, cracked' },
      { context: asUser(ALICE, WS_REPAIR) },
    )
    // One column decides the derived status, so exactly one procedure moves it.
    expect(await statusOf(WS_REPAIR, asset.id)).toBe('under_repair')
  })

  it('answers what is away across the workspace, with the asset each one belongs to', async () => {
    const asset = await createAsset(WS_STATS, { name: 'Away and named' })
    await sendForRepair(WS_STATS, asset.id, { summary: 'Power supply' })
    const { items } = await call(
      inv.repairs.list,
      { workspaceId: WS_STATS, open: true },
      { context: asUser(ALICE, WS_STATS) },
    )
    // A workspace-wide list of ids would be unreadable; the tag and name are joined at read time,
    // so renaming the asset renames it here at once.
    expect(items.map((r) => r.assetName)).toContain('Away and named')
    expect(items[0]?.assetCode).toMatch(/^INV-/)
  })

  it('narrows to one asset, and to finished repairs', async () => {
    const asset = await createAsset(WS_STATS, { name: 'Twice mended' })
    const first = await sendForRepair(WS_STATS, asset.id, { summary: 'One' })
    await completeRepair(WS_STATS, first.repair.id)
    await sendForRepair(WS_STATS, asset.id, { summary: 'Two' })
    const mine = await call(
      inv.repairs.list,
      { workspaceId: WS_STATS, assetId: asset.id },
      { context: asUser(ALICE, WS_STATS) },
    )
    expect(mine.items.map((r) => r.summary)).toEqual(['Two', 'One'])
    const finished = await call(
      inv.repairs.list,
      { workspaceId: WS_STATS, assetId: asset.id, open: false },
      { context: asUser(ALICE, WS_STATS) },
    )
    expect(finished.items.map((r) => r.summary)).toEqual(['One'])
  })

  it('answers "not yours" rather than an empty list for another workspace’s asset', async () => {
    const mine = await createAsset(WS_REPAIR, { name: 'Ours alone' })
    const code = await refusedWith(() =>
      call(inv.repairs.list, { workspaceId: WS_B, assetId: mine.id }, { context: asUser(BOB, WS_B) }),
    )
    // An empty list reads as "it has never been repaired", which is a different sentence.
    expect(code).toBe('NOT_FOUND')
  })

  it('refuses a repair from another workspace as missing rather than editing it', async () => {
    const asset = await createAsset(WS_REPAIR, { name: 'Untouchable repair' })
    const { repair } = await sendForRepair(WS_REPAIR, asset.id, { summary: 'Ours' })
    expect(
      await refusedWith(() =>
        call(
          inv.repairs.update,
          { workspaceId: WS_B, repairId: repair.id, summary: 'Stolen' },
          { context: asUser(BOB, WS_B) },
        ),
      ),
    ).toBe('NOT_FOUND')
  })
})

/**
 * Files, which this module records and never holds.
 *
 * The load-bearing test is the workspace check: the file id arrives in the request, so without it a
 * member of one workspace could attach another workspace's file and read its name and size back out
 * of the list. The module boundary does not help — core answers this module as a service.
 */
describe('attaching files', () => {
  it('records what core says a file is, and lists it back', async () => {
    const asset = await createAsset(WS_FILES, { name: 'Filed away' })
    const fileId = seedFile(WS_FILES, 'Purchase receipt.pdf')
    const added = await call(
      inv.attachments.add,
      { workspaceId: WS_FILES, assetId: asset.id, fileIds: [fileId] },
      { context: asUser(ALICE, WS_FILES) },
    )
    expect(added.map((a) => a.name)).toEqual(['Purchase receipt.pdf'])
    const listed = await call(
      inv.attachments.list,
      { workspaceId: WS_FILES, assetId: asset.id },
      { context: asUser(ALICE, WS_FILES) },
    )
    // Name and size are copied at attach time, so a list is one query rather than one query plus a
    // call to core per row.
    expect(listed[0]).toMatchObject({ name: 'Purchase receipt.pdf', size: 12_345, repairId: null })
  })

  it('refuses a file belonging to another workspace', async () => {
    const asset = await createAsset(WS_FILES, { name: 'Not yours' })
    const theirs = seedFile(WS_B, 'Somebody else’s contract.pdf')
    expect(
      await refusedWith(() =>
        call(
          inv.attachments.add,
          { workspaceId: WS_FILES, assetId: asset.id, fileIds: [theirs] },
          { context: asUser(ALICE, WS_FILES) },
        ),
      ),
    ).toBe('BAD_REQUEST')
  })

  it('refuses a file whose upload never finished', async () => {
    const asset = await createAsset(WS_FILES, { name: 'Half uploaded' })
    const pending = seedFile(WS_FILES, 'Half a scan.pdf', 'pending')
    expect(
      await refusedWith(() =>
        call(
          inv.attachments.add,
          { workspaceId: WS_FILES, assetId: asset.id, fileIds: [pending] },
          { context: asUser(ALICE, WS_FILES) },
        ),
      ),
    ).toBe('BAD_REQUEST')
  })

  it('adds the same file once, however many times it arrives', async () => {
    const asset = await createAsset(WS_FILES, { name: 'Double dropped' })
    const fileId = seedFile(WS_FILES, 'Warranty.pdf')
    const once = await call(
      inv.attachments.add,
      { workspaceId: WS_FILES, assetId: asset.id, fileIds: [fileId, fileId] },
      { context: asUser(ALICE, WS_FILES) },
    )
    expect(once).toHaveLength(1)
    // Somebody pressed the button twice; that is not an error worth refusing.
    const again = await call(
      inv.attachments.add,
      { workspaceId: WS_FILES, assetId: asset.id, fileIds: [fileId] },
      { context: asUser(ALICE, WS_FILES) },
    )
    expect(again).toEqual([])
  })

  it('files a repair’s paperwork under that repair, and refuses another asset’s', async () => {
    const asset = await createAsset(WS_FILES, { name: 'With an invoice' })
    const other = await createAsset(WS_FILES, { name: 'Somebody else’s repair' })
    const { repair } = await sendForRepair(WS_FILES, other.id, { summary: 'Elsewhere' })
    const fileId = seedFile(WS_FILES, 'Invoice.pdf')
    expect(
      await refusedWith(() =>
        call(
          inv.attachments.add,
          { workspaceId: WS_FILES, assetId: asset.id, fileIds: [fileId], repairId: repair.id },
          { context: asUser(ALICE, WS_FILES) },
        ),
      ),
    ).toBe('NOT_FOUND')

    const mine = await sendForRepair(WS_FILES, asset.id, { summary: 'Ours' })
    const filed = await call(
      inv.attachments.add,
      { workspaceId: WS_FILES, assetId: asset.id, fileIds: [fileId], repairId: mine.repair.id },
      { context: asUser(ALICE, WS_FILES) },
    )
    expect(filed[0]?.repairId).toBe(mine.repair.id)
  })

  it('detaches one file and records it, leaving core’s copy alone', async () => {
    const asset = await createAsset(WS_FILES, { name: 'Detachable' })
    const fileId = seedFile(WS_FILES, 'Manual.pdf')
    const [added] = await call(
      inv.attachments.add,
      { workspaceId: WS_FILES, assetId: asset.id, fileIds: [fileId] },
      { context: asUser(ALICE, WS_FILES) },
    )
    const removed = await call(
      inv.attachments.remove,
      { workspaceId: WS_FILES, attachmentId: added!.id },
      { context: asUser(ALICE, WS_FILES) },
    )
    expect(removed).toEqual({ id: added!.id })
    // The file itself is core's and is untouched — this module never owned it.
    expect(FILES.get(fileId)?.name).toBe('Manual.pdf')
    const { items } = await call(
      inv.assets.history,
      { workspaceId: WS_FILES, assetId: asset.id },
      { context: asUser(ALICE, WS_FILES) },
    )
    expect(items.map((e) => e.action)).toEqual(['attachment_removed', 'attachment_added', 'created'])
  })

  it('answers "not yours" for another workspace’s asset', async () => {
    const mine = await createAsset(WS_FILES, { name: 'Private paperwork' })
    expect(
      await refusedWith(() =>
        call(inv.attachments.list, { workspaceId: WS_B, assetId: mine.id }, { context: asUser(BOB, WS_B) }),
      ),
    ).toBe('NOT_FOUND')
  })
})

/**
 * The one file id the module used to take on trust.
 *
 * `attachments.add` has always asked core whose file an id is before recording it. `assets.create`
 * and `assets.update` did not, so `photoFileId` went into the row exactly as it arrived — and a
 * member of one workspace could point an asset at another workspace's file and read its name back
 * out through the panel that renders it. The module boundary is no help: core answers this module as
 * a service, so the id is the only thing between the two workspaces.
 */
describe('an asset’s photo', () => {
  const ctx = () => ({ context: asUser(ALICE, WS_FILES) })

  it('refuses a file belonging to another workspace, exactly as an attachment does', async () => {
    const foreign = seedFile(WS_B, 'someone-elses-laptop.jpg')
    expect(
      await refusedWith(() =>
        call(
          inv.assets.create,
          { workspaceId: WS_FILES, name: 'Borrowed photo', photoFileId: foreign },
          ctx(),
        ),
      ),
    ).toBe('BAD_REQUEST')
  })

  it('refuses one on an edit as well, and leaves the photo alone', async () => {
    const own = seedFile(WS_FILES, 'ours.jpg')
    const asset = await call(
      inv.assets.create,
      { workspaceId: WS_FILES, name: 'Has its own photo', photoFileId: own },
      ctx(),
    )
    const foreign = seedFile(WS_B, 'not-ours.jpg')
    expect(
      await refusedWith(() =>
        call(inv.assets.update, { workspaceId: WS_FILES, assetId: asset.id, photoFileId: foreign }, ctx()),
      ),
    ).toBe('BAD_REQUEST')

    const after = await call(inv.assets.get, { workspaceId: WS_FILES, assetId: asset.id }, ctx())
    expect(after.photoFileId).toBe(own)
  })

  it('refuses one whose upload never finished, and accepts one of this workspace’s own', async () => {
    const unfinished = seedFile(WS_FILES, 'still-uploading.jpg', 'uploading')
    expect(
      await refusedWith(() =>
        call(
          inv.assets.create,
          { workspaceId: WS_FILES, name: 'Half a photo', photoFileId: unfinished },
          ctx(),
        ),
      ),
    ).toBe('BAD_REQUEST')

    // The other half: a check that refused everything would hide behind the same assertions.
    const own = seedFile(WS_FILES, 'finished.jpg')
    const asset = await call(
      inv.assets.create,
      { workspaceId: WS_FILES, name: 'A photo of its own', photoFileId: own },
      ctx(),
    )
    expect(asset.photoFileId).toBe(own)

    // And clearing it is not a file to check, so it is not refused.
    const cleared = await call(
      inv.assets.update,
      { workspaceId: WS_FILES, assetId: asset.id, photoFileId: null },
      ctx(),
    )
    expect(cleared.photoFileId).toBeNull()
  })
})

/**
 * A capability that is off answers **404, not 403**.
 *
 * 403 says "this exists and you may not have it", which is false for a workspace that never bought
 * the feature — and it contradicts a panel that has already hidden the tab. This is the module's
 * first switchable capability, so this block is the first proof that the mechanism does anything at
 * all: without it, `requiresCapability` could be missing from every procedure and every other test
 * in this file would still pass.
 */
describe('a workspace with a capability switched off', () => {
  it('answers NOT_FOUND from every repairs procedure, and not FORBIDDEN', async () => {
    const asset = await createAsset(WS_CAP, { name: 'In a workspace without repairs' })
    // Sent while the capability is still on, so what is being tested afterwards is the gate rather
    // than a missing row.
    const { repair } = await sendForRepair(WS_CAP, asset.id, { summary: 'Before the switch' })

    await withCapabilities({ repairs: false }, async () => {
      const user = () => ({ context: asUser(ALICE, WS_CAP) })
      const refusals = await Promise.all([
        refusedWith(() => call(inv.repairs.list, { workspaceId: WS_CAP }, user())),
        refusedWith(() =>
          call(inv.repairs.create, { workspaceId: WS_CAP, assetId: asset.id, summary: 'No' }, user()),
        ),
        refusedWith(() =>
          call(inv.repairs.update, { workspaceId: WS_CAP, repairId: repair.id, summary: 'No' }, user()),
        ),
        refusedWith(() => call(inv.repairs.complete, { workspaceId: WS_CAP, repairId: repair.id }, user())),
      ])
      expect(refusals).toEqual(['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND'])
    })
  })

  it('answers NOT_FOUND from every attachments procedure', async () => {
    const asset = await createAsset(WS_CAP, { name: 'In a workspace without files' })
    const fileId = seedFile(WS_CAP, 'Receipt.pdf')
    const [added] = await call(
      inv.attachments.add,
      { workspaceId: WS_CAP, assetId: asset.id, fileIds: [fileId] },
      { context: asUser(ALICE, WS_CAP) },
    )

    await withCapabilities({ attachments: false }, async () => {
      const user = () => ({ context: asUser(ALICE, WS_CAP) })
      const refusals = await Promise.all([
        refusedWith(() => call(inv.attachments.list, { workspaceId: WS_CAP, assetId: asset.id }, user())),
        refusedWith(() =>
          call(inv.attachments.add, { workspaceId: WS_CAP, assetId: asset.id, fileIds: [fileId] }, user()),
        ),
        refusedWith(() =>
          call(inv.attachments.remove, { workspaceId: WS_CAP, attachmentId: added!.id }, user()),
        ),
      ])
      expect(refusals).toEqual(['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND'])
    })
  })

  it('leaves the rest of the module working, and says it has no opinion about repairs', async () => {
    await withCapabilities({ repairs: false }, async () => {
      const listed = await listAssets(WS_CAP)
      expect(listed.items.length).toBeGreaterThan(0)
      const stats = await call(inv.stats.summary, { workspaceId: WS_CAP }, { context: asUser(ALICE, WS_CAP) })
      // Null, not 0: zero would be a claim ("nothing is away") that this workspace has not made.
      // And the count line must not disappear because a *different* feature is switched off.
      expect(stats.outForRepair).toBeNull()
      expect(stats.total).toBeGreaterThan(0)
    })
  })

  it('switches back on without anything having been destroyed', async () => {
    // A capability is a flag in settings; the rows stay exactly where they were. Anything needing
    // a migration to reverse does not belong behind one.
    const { items } = await call(
      inv.repairs.list,
      { workspaceId: WS_CAP },
      { context: asUser(ALICE, WS_CAP) },
    )
    expect(items.map((r) => r.summary)).toContain('Before the switch')
  })
})

describe('the register in numbers', () => {
  it('counts live rows, keeps archived ones beside them and zero-fills every status', async () => {
    const kept = await createAsset(WS_STATS, { name: 'Counted' })
    const gone = await createAsset(WS_STATS, { name: 'Archived' })
    await call(
      inv.assets.archive,
      { workspaceId: WS_STATS, assetId: gone.id, archived: true },
      { context: asUser(ALICE, WS_STATS) },
    )
    const stats = await call(
      inv.stats.summary,
      { workspaceId: WS_STATS },
      { context: asUser(ALICE, WS_STATS) },
    )
    expect(stats.archived).toBeGreaterThan(0)
    // A count line that silently included archived rows would disagree with the list under it.
    const live = await listAssets(WS_STATS, { limit: 200 })
    expect(stats.total).toBe(live.items.length)
    expect(Object.keys(stats.byStatus).sort()).toEqual([
      'assigned',
      'in_stock',
      'lost',
      'reserved',
      'retired',
      'under_repair',
    ])
    // Nothing writes `lost`, and a missing key and a zero are not the same thing to a `Record`.
    expect(stats.byStatus.lost).toBe(0)
    expect(stats.byStatus.in_stock).toBeGreaterThan(0)
    expect(kept.archivedAt).toBeNull()
  })

  it('agrees with itself about what is away', async () => {
    // Two ways of asking one question: the cached `status` column that every list filters on, and
    // the repair rows the column is derived from. `deriveStatus` is what keeps them equal — and
    // `assets.archive` refusing an item that is away is what keeps them equal for archived rows.
    const stats = await call(
      inv.stats.summary,
      { workspaceId: WS_STATS },
      { context: asUser(ALICE, WS_STATS) },
    )
    expect(stats.outForRepair).toBe(stats.byStatus.under_repair)
  })

  it('counts what nobody is holding', async () => {
    const before = await call(
      inv.stats.summary,
      { workspaceId: WS_STATS },
      { context: asUser(ALICE, WS_STATS) },
    )
    const free = await createAsset(WS_STATS, { name: 'About to be handed over' })
    await call(
      inv.custody.assign,
      { workspaceId: WS_STATS, assetId: free.id, userId: BOB },
      { context: asUser(ALICE, WS_STATS) },
    )
    const after = await call(
      inv.stats.summary,
      { workspaceId: WS_STATS },
      { context: asUser(ALICE, WS_STATS) },
    )
    // One more asset, and the same number of unheld ones.
    expect({ total: after.total, unassigned: after.unassigned }).toEqual({
      total: before.total + 1,
      unassigned: before.unassigned,
    })
  })

  it('does not count another workspace’s assets', async () => {
    const stats = await call(inv.stats.summary, { workspaceId: WS_B }, { context: asUser(BOB, WS_B) })
    const theirs = await listAssets(WS_B, { limit: 200 }, BOB)
    expect(stats.total).toBe(theirs.items.length)
  })
})

// =================================================================================================
// The platform surfaces: search, references, scheduled work, service calls and offboarding.
//
// Everything below leaves the module. The suite above proves the register is *correct*; this proves
// the rest of the product can find it, point at it, and be told about it — which is a different
// class of bug, and one that type-checking cannot see at all: a `SearchIndexer` with the wrong
// document shape compiles, a resolver nobody guards compiles, a job that enumerates no workspaces
// compiles and runs to completion every night doing nothing.
// =================================================================================================

/** `YYYY-MM-DD`, `n` days from today in UTC — the same arithmetic `jobs.ts` does. */
const inDays = (days: number): string => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const jobNamed = (name: string) => {
  const job = inventoryModule.jobs?.find((j) => j.name === name)
  if (!job) throw new Error(`No job called ${name}`)
  return () => job.handler({}, { kernel, id: randomUUID(), attempt: 0 })
}

/** The indexed document for one asset, or undefined — the last one written, which is the live one. */
const documentFor = (assetId: string) => INDEXED.filter((d) => d.object.id === assetId).at(-1)

describe('an asset in the workspace-wide search index', () => {
  let assetId: string
  let categoryId: string

  beforeAll(async () => {
    const category = await call(
      inv.categories.create,
      { workspaceId: WS_SEARCH, name: 'Cameras' },
      { context: asUser(ALICE, WS_SEARCH) },
    )
    categoryId = category.id
    const asset = await createAsset(WS_SEARCH, {
      name: 'Blackmagic Pocket 6K',
      description: 'The one with the dented cage',
      serialNumber: 'BM-99120',
      location: 'Studio cupboard',
      categoryId,
    })
    assetId = asset.id
  }, 60_000)

  it('leads with the tag, because that is what is printed on the sticker', () => {
    const doc = documentFor(assetId)
    expect(doc?.title).toMatch(/^INV-\d+ Blackmagic Pocket 6K$/)
  })

  it('indexes the serial, the location and the category name, not only the name', () => {
    const body = documentFor(assetId)?.body ?? ''
    for (const word of ['BM-99120', 'Studio cupboard', 'Cameras', 'dented cage'])
      expect({ word, found: body.includes(word) }).toEqual({ word, found: true })
  })

  it('points at the panel the shell actually opens', () => {
    const doc = documentFor(assetId)
    expect(doc?.url).toBe(`/inventory?asset=${assetId}`)
    expect(doc?.object).toEqual({ module: 'inventory', type: 'asset', id: assetId })
    expect(doc?.icon).toBe('briefcase')
    // Workspace-wide visibility: `inventory.asset.view` is not a per-row permission, so naming a
    // narrower audience would be a claim this module cannot keep.
    expect(doc?.acl).toBeNull()
  })

  it('carries the attributes a filter would need, and no row of its own', () => {
    expect(documentFor(assetId)?.attributes).toMatchObject({
      status: 'in_stock',
      categoryId,
      custodianUserId: null,
    })
  })

  it('takes an archived asset back out of the index rather than leaving a dead link', async () => {
    const asset = await createAsset(WS_SEARCH, { name: 'Broken tripod' })
    expect(documentFor(asset.id), 'indexed when created').toBeDefined()

    await call(
      inv.assets.archive,
      { workspaceId: WS_SEARCH, assetId: asset.id, archived: true },
      { context: asUser(ALICE, WS_SEARCH) },
    )
    expect(UNINDEXED).toContainEqual({
      workspaceId: WS_SEARCH,
      object: { module: 'inventory', type: 'asset', id: asset.id },
    })
    // And the indexer agrees, which is what `core.search.reindex` would act on.
    expect(await inventoryServices(kernel).search.load(WS_SEARCH, asset.id)).toBeNull()

    await call(
      inv.assets.archive,
      { workspaceId: WS_SEARCH, assetId: asset.id, archived: false },
      { context: asUser(ALICE, WS_SEARCH) },
    )
    expect(await inventoryServices(kernel).search.load(WS_SEARCH, asset.id)).not.toBeNull()
  })

  it('reindexes when custody moves, because the document carries the custodian', async () => {
    await call(
      inv.custody.assign,
      { workspaceId: WS_SEARCH, assetId, userId: BOB },
      { context: asUser(ALICE, WS_SEARCH) },
    )
    expect(documentFor(assetId)?.attributes).toMatchObject({
      status: 'assigned',
      custodianUserId: BOB,
    })
    await call(inv.custody.return, { workspaceId: WS_SEARCH, assetId }, { context: asUser(ALICE, WS_SEARCH) })
  })

  it('scans every live asset of the workspace and nobody else’s', async () => {
    const scanned: core.SearchDocument[] = []
    for await (const doc of inventoryServices(kernel).search.scan(WS_SEARCH)) scanned.push(doc)

    const live = await listAssets(WS_SEARCH, { limit: 200 })
    expect(scanned.map((d) => d.object.id).sort()).toEqual(live.items.map((a) => a.id).sort())
    for (const doc of scanned) expect(doc.workspaceId).toBe(WS_SEARCH)
  })
})

describe('an `inventory:asset:<id>` reference rendered somewhere else', () => {
  const resolver = () => {
    const found = inventoryModule.resolvers?.find((r) => r.type === 'asset')
    if (!found) throw new Error('the module declares an `asset` object type with no resolver')
    return found
  }

  it('is declared as an object type, so the reference can be written in the first place', () => {
    expect(inventoryModule.definition.objectTypes).toEqual([
      { type: 'asset', label: 'Asset', icon: 'briefcase', channelable: false },
    ])
  })

  it('answers with a title, a url and an icon, and null for one that is not there', async () => {
    const asset = await createAsset(WS_A, { name: 'Meeting room screen' })
    const missing = randomUUID()
    const resolved = await resolver().resolve(WS_A, [asset.id, missing], principal(ALICE, WS_A), kernel)
    expect(resolved[0]).toEqual({
      id: asset.id,
      title: `${asset.code} Meeting room screen`,
      url: `/inventory?asset=${asset.id}`,
      icon: 'briefcase',
      subtitle: 'in_stock',
    })
    expect(resolved[1], 'an id this workspace does not have').toBeNull()
  })

  it('still resolves an archived asset, where search drops it', async () => {
    const asset = await createAsset(WS_A, { name: 'Retired printer' })
    await call(
      inv.assets.archive,
      { workspaceId: WS_A, assetId: asset.id, archived: true },
      { context: asUser(ALICE, WS_A) },
    )
    const [resolved] = await resolver().resolve(WS_A, [asset.id], principal(ALICE, WS_A), kernel)
    // A link written last year must not turn into nothing; it says what it is instead — in the
    // module's own status vocabulary rather than an English sentence a resolver cannot translate.
    expect(resolved?.subtitle).toBe('archived')
    expect(resolved?.title).toContain('Retired printer')
  })

  it('tells somebody outside the workspace nothing at all', async () => {
    const asset = await createAsset(WS_A, { name: 'Confidential prototype' })
    // A principal with no membership here: `authz.can` is what refuses, which is the same check the
    // router makes, rather than a second rule written into the resolver.
    const outsider = principal(BOB, WS_B)
    const resolved = await resolver().resolve(WS_A, [asset.id], outsider, kernel)
    expect(resolved).toEqual([null])
  })
})

describe('the procedures other services call', () => {
  it('refuses a person, however many workspaces they are an admin of', async () => {
    const asset = await createAsset(WS_A, { name: 'Service-guarded laptop' })
    for (const name of ['inventory.asset.byId', 'inventory.assets.byCustodian']) {
      const code = await refusedWith(() =>
        kernel.call(name, { workspaceId: WS_A, assetId: asset.id, userId: ALICE }, principal(ALICE, WS_A)),
      )
      expect({ name, code }).toEqual({ name, code: 'FORBIDDEN' })
    }
  })

  it('answers a service with the asset, and with what one person is holding', async () => {
    const asset = await createAsset(WS_A, { name: 'Loaned monitor' })
    await call(
      inv.custody.assign,
      { workspaceId: WS_A, assetId: asset.id, userId: BOB },
      { context: asUser(ALICE, WS_A) },
    )

    const one = await kernel.call<Asset>('inventory.asset.byId', {
      workspaceId: WS_A,
      assetId: asset.id,
    })
    expect(one.code).toBe(asset.code)
    expect(one.custodianUserId).toBe(BOB)

    const held = await kernel.call<{ items: Asset[] }>('inventory.assets.byCustodian', {
      workspaceId: WS_A,
      userId: BOB,
    })
    expect(held.items.map((a) => a.id)).toContain(asset.id)
    // Answered through the one list path, so it inherits the archived-row rule rather than a
    // second query's opinion of it.
    for (const item of held.items) expect(item.archivedAt).toBeNull()
  })
})

describe('switching the module on for a workspace', () => {
  const enable = () => inventoryModule.onWorkspaceEnabled?.(WS_SEED, kernel)

  it('seeds a filing system, so the asset form’s picker is not empty on day one', async () => {
    await enable()
    const list = await call(
      inv.categories.list,
      { workspaceId: WS_SEED },
      { context: asUser(ALICE, WS_SEED) },
    )
    expect(list.map((c) => c.name)).toEqual(['Laptops', 'Phones', 'Monitors', 'Furniture', 'Vehicles'])
  })

  it('registers the workspace so the sweeps can find it', async () => {
    const rows = await kernel.database.withWorkspace(WS_SEED, (tx) =>
      tx.select().from(workspaces).where(eq(workspaces.workspaceId, WS_SEED)),
    )
    expect(rows).toHaveLength(1)
  })

  it('runs again without seeding a second time', async () => {
    // Somebody switches the module off and back on. Both halves have to survive it: a second
    // registry row is impossible by the primary key, and a second set of categories is what the
    // "has none at all" guard exists to prevent.
    await enable()
    await enable()
    const list = await call(
      inv.categories.list,
      { workspaceId: WS_SEED },
      { context: asUser(ALICE, WS_SEED) },
    )
    expect(list).toHaveLength(5)
    const rows = await kernel.database.withWorkspace(WS_SEED, (tx) =>
      tx.select().from(workspaces).where(eq(workspaces.workspaceId, WS_SEED)),
    )
    expect(rows).toHaveLength(1)
  })

  it('does not re-create a default somebody renamed', async () => {
    // The failure the name-keyed version would have: rename "Laptops" to "Notebooks", toggle the
    // module, and an admin is handed a duplicate of their own category under the name they rejected.
    const list = await call(
      inv.categories.list,
      { workspaceId: WS_SEED },
      { context: asUser(ALICE, WS_SEED) },
    )
    const laptops = list.find((c) => c.name === 'Laptops')!
    await call(
      inv.categories.update,
      { workspaceId: WS_SEED, categoryId: laptops.id, name: 'Notebooks' },
      { context: asUser(ALICE, WS_SEED) },
    )
    await enable()
    const after = await call(
      inv.categories.list,
      { workspaceId: WS_SEED },
      { context: asUser(ALICE, WS_SEED) },
    )
    expect(after.map((c) => c.name).sort()).toEqual(
      ['Furniture', 'Monitors', 'Notebooks', 'Phones', 'Vehicles'].sort(),
    )
  })
})

describe('the nightly sweeps', () => {
  let expiring: Asset
  let spare: Asset
  let away: Asset

  beforeAll(async () => {
    // OLIVE looks after the register; DANA is handed things. Both are what an audience is worked
    // out from, through the real permission engine rather than a lookup table.
    seedMember(WS_SWEEP, OLIVE, 'admin', 'Olive Ferrer')
    seedMember(WS_SWEEP, DANA, 'member', 'Dana Okoro')
    await inventoryModule.onWorkspaceEnabled?.(WS_SWEEP, kernel)

    expiring = await createAsset(WS_SWEEP, { name: 'Dana’s laptop', warrantyUntil: inDays(10) }, OLIVE)
    await call(
      inv.custody.assign,
      { workspaceId: WS_SWEEP, assetId: expiring.id, userId: DANA },
      { context: asUser(OLIVE, WS_SWEEP) },
    )
    spare = await createAsset(WS_SWEEP, { name: 'Spare projector', warrantyUntil: inDays(3) }, OLIVE)
    // Well outside the 30-day default window, so a sweep that ignored the window would be caught.
    await createAsset(WS_SWEEP, { name: 'New printer', warrantyUntil: inDays(400) }, OLIVE)

    away = await createAsset(WS_SWEEP, { name: 'Cracked monitor' }, OLIVE)
    await call(
      inv.repairs.create,
      { workspaceId: WS_SWEEP, assetId: away.id, summary: 'Cracked panel', sentOn: inDays(-30) },
      { context: asUser(OLIVE, WS_SWEEP) },
    )
  }, 60_000)

  it('tells whoever is holding the item, and whoever may replace one nobody holds', async () => {
    NOTIFICATIONS.length = 0
    await jobNamed('warranty-sweep')()

    const sent = notificationsOfType('inventory.warranty.expiring')
    const forDanas = sent.filter((n) => n.url === `/inventory?asset=${expiring.id}`)
    expect(
      forDanas.map((n) => n.userId),
      'the holder, and only the holder',
    ).toEqual([DANA])
    expect(forDanas[0]?.title).toContain(expiring.code)

    const forSpare = sent.filter((n) => n.url === `/inventory?asset=${spare.id}`)
    // Nobody is holding it, so it falls to whoever holds `inventory.asset.manage` — which by
    // default is every member, capped and ordered by role.
    expect(forSpare.map((n) => n.userId).sort()).toEqual([DANA, OLIVE].sort())
  })

  it('leaves the one outside the window alone', () => {
    const codes = notificationsOfType('inventory.warranty.expiring').map((n) => n.title)
    expect(codes.some((title) => title.includes('New printer'))).toBe(false)
  })

  it('says it once and then stops, however many mornings it runs', async () => {
    const [row] = await kernel.database.withWorkspace(WS_SWEEP, (tx) =>
      tx.select({ at: assets.warrantyNotifiedAt }).from(assets).where(eq(assets.id, expiring.id)),
    )
    expect(row?.at, 'the marker that makes the sweep idempotent').not.toBeNull()

    NOTIFICATIONS.length = 0
    await jobNamed('warranty-sweep')()
    expect(notificationsOfType('inventory.warranty.expiring')).toEqual([])
  })

  it('re-arms when the warranty date itself moves, and not when anything else does', async () => {
    NOTIFICATIONS.length = 0
    await call(
      inv.assets.update,
      { workspaceId: WS_SWEEP, assetId: expiring.id, location: 'Second desk' },
      { context: asUser(OLIVE, WS_SWEEP) },
    )
    await jobNamed('warranty-sweep')()
    expect(notificationsOfType('inventory.warranty.expiring'), 'an edit is not a new warranty').toEqual([])

    await call(
      inv.assets.update,
      { workspaceId: WS_SWEEP, assetId: expiring.id, warrantyUntil: inDays(20) },
      { context: asUser(OLIVE, WS_SWEEP) },
    )
    await jobNamed('warranty-sweep')()
    expect(notificationsOfType('inventory.warranty.expiring').map((n) => n.userId)).toEqual([DANA])
  })

  /**
   * A marker that says "told them" has to mean somebody was told.
   *
   * Everything this module sends is best-effort: `NotifyService` swallows a failed
   * `core.notifications.create` and logs it, which is right — an inventory mutation must not fail
   * because core is briefly away. The sweep then wrote `warranty_notified_at` regardless, and the
   * notice is sent **once per asset ever**. So one bad night did not delay the notice, it cancelled
   * it: for the life of the row, nobody would ever hear that the warranty was running out.
   *
   * Left unmarked, the sweep simply says it again in the morning, which is the whole reason it runs
   * every day.
   */
  it('marks nothing when the notice never left, and says it again the next morning', async () => {
    const flaky = await createAsset(
      WS_SWEEP,
      { name: 'Nobody heard about this one', warrantyUntil: inDays(5) },
      OLIVE,
    )

    NOTIFICATIONS.length = 0
    notificationsFail = true
    try {
      await jobNamed('warranty-sweep')()
    } finally {
      notificationsFail = false
    }
    expect(notificationsOfType('inventory.warranty.expiring')).toEqual([])

    const [before] = await kernel.database.withWorkspace(WS_SWEEP, (tx) =>
      tx.select({ at: assets.warrantyNotifiedAt }).from(assets).where(eq(assets.id, flaky.id)),
    )
    expect(before?.at, 'a notice that never left is not a notice that was sent').toBeNull()

    // The next morning, with core back.
    await jobNamed('warranty-sweep')()
    expect(notificationsOfType('inventory.warranty.expiring').map((n) => n.url)).toContain(
      `/inventory?asset=${flaky.id}`,
    )
    const [after] = await kernel.database.withWorkspace(WS_SWEEP, (tx) =>
      tx.select({ at: assets.warrantyNotifiedAt }).from(assets).where(eq(assets.id, flaky.id)),
    )
    expect(after?.at, 'and once it has actually been sent, it is marked and stops').not.toBeNull()
  })

  /**
   * A notice that reached one of two people is not a notice that was sent.
   *
   * The marker column holds one answer for a row whose audience is a *set*, and `notify` is one call
   * to core per recipient. The sweep used to mark the row whenever at least one of those calls landed
   * — so a spare with two managers behind it needed one write to succeed for the row to be stamped
   * *told*, and the other manager was never told and never would be: the notice is sent once per row
   * ever and nothing clears the marker.
   *
   * One column cannot hold two answers, so it holds the pessimistic one. Whoever did hear it hears it
   * again in the morning, which `groupKey` collapses where a client groups, and nobody is left out.
   */
  it('marks nothing when only some of the people were told', async () => {
    const partly = await createAsset(
      WS_SWEEP,
      { name: 'Heard by half the office', warrantyUntil: inDays(6) },
      OLIVE,
    )

    NOTIFICATIONS.length = 0
    // Nobody is holding it, so the audience is everybody who may replace one — Dana and Olive. Core
    // takes Dana's and refuses Olive's, which is exactly the case a single count cannot describe.
    NOTIFICATIONS_FAIL_FOR.add(OLIVE)
    try {
      await jobNamed('warranty-sweep')()
    } finally {
      NOTIFICATIONS_FAIL_FOR.clear()
    }
    const partial = notificationsOfType('inventory.warranty.expiring').filter(
      (n) => n.url === `/inventory?asset=${partly.id}`,
    )
    expect(
      partial.map((n) => n.userId),
      'one of the two really was told',
    ).toEqual([DANA])

    const [before] = await kernel.database.withWorkspace(WS_SWEEP, (tx) =>
      tx.select({ at: assets.warrantyNotifiedAt }).from(assets).where(eq(assets.id, partly.id)),
    )
    expect(before?.at, 'and the row is not stamped told, because Olive was not').toBeNull()

    // The next morning, with core back: both of them, and only then is it marked.
    NOTIFICATIONS.length = 0
    await jobNamed('warranty-sweep')()
    expect(
      notificationsOfType('inventory.warranty.expiring')
        .filter((n) => n.url === `/inventory?asset=${partly.id}`)
        .map((n) => n.userId)
        .sort(),
    ).toEqual([DANA, OLIVE].sort())
    const [after] = await kernel.database.withWorkspace(WS_SWEEP, (tx) =>
      tx.select({ at: assets.warrantyNotifiedAt }).from(assets).where(eq(assets.id, partly.id)),
    )
    expect(after?.at).not.toBeNull()

    // And it stops: the third morning says nothing at all about it.
    NOTIFICATIONS.length = 0
    await jobNamed('warranty-sweep')()
    expect(
      notificationsOfType('inventory.warranty.expiring').filter(
        (n) => n.url === `/inventory?asset=${partly.id}`,
      ),
    ).toEqual([])
  })

  it('chases a repair nobody has logged back, once', async () => {
    NOTIFICATIONS.length = 0
    await jobNamed('repair-overdue')()

    const sent = notificationsOfType('inventory.repair.overdue')
    // The person who logged it — they committed the company to the money and have the number.
    expect(sent.map((n) => n.userId)).toEqual([OLIVE])
    expect(sent[0]?.url).toBe(`/inventory?asset=${away.id}`)

    NOTIFICATIONS.length = 0
    await jobNamed('repair-overdue')()
    expect(notificationsOfType('inventory.repair.overdue')).toEqual([])
  })

  /** The same rule for the other sweep, and the other marker. See the warranty version above. */
  it('leaves an overdue repair unmarked when the chase never left', async () => {
    const stuck = await createAsset(WS_SWEEP, { name: 'Chased into the void' }, OLIVE)
    const { repair } = await call(
      inv.repairs.create,
      { workspaceId: WS_SWEEP, assetId: stuck.id, summary: 'Power supply', sentOn: inDays(-45) },
      { context: asUser(OLIVE, WS_SWEEP) },
    )

    NOTIFICATIONS.length = 0
    notificationsFail = true
    try {
      await jobNamed('repair-overdue')()
    } finally {
      notificationsFail = false
    }
    expect(notificationsOfType('inventory.repair.overdue')).toEqual([])

    const [before] = await kernel.database.withWorkspace(WS_SWEEP, (tx) =>
      tx.select({ at: repairs.overdueNotifiedAt }).from(repairs).where(eq(repairs.id, repair.id)),
    )
    expect(before?.at, 'a chase nobody received is not a chase that happened').toBeNull()

    await jobNamed('repair-overdue')()
    expect(notificationsOfType('inventory.repair.overdue').map((n) => n.url)).toContain(
      `/inventory?asset=${stuck.id}`,
    )
    const [after] = await kernel.database.withWorkspace(WS_SWEEP, (tx) =>
      tx.select({ at: repairs.overdueNotifiedAt }).from(repairs).where(eq(repairs.id, repair.id)),
    )
    expect(after?.at).not.toBeNull()
  })

  it('says nothing at all in a workspace that does not record repairs', async () => {
    // Re-arm the marker so the only thing that can keep the sweep quiet is the capability.
    await kernel.database.withWorkspace(WS_SWEEP, (tx) =>
      tx.update(repairs).set({ overdueNotifiedAt: null }).where(eq(repairs.assetId, away.id)),
    )
    NOTIFICATIONS.length = 0
    await withCapabilities({ repairs: false }, async () => {
      await jobNamed('repair-overdue')()
      expect(notificationsOfType('inventory.repair.overdue')).toEqual([])
    }, [WS_SWEEP])

    // And it is genuinely the capability doing it: switched back on, the same run speaks.
    await jobNamed('repair-overdue')()
    expect(notificationsOfType('inventory.repair.overdue').map((n) => n.userId)).toEqual([OLIVE])
  })

  it('never touches a workspace that has not been registered', async () => {
    const rows = await kernel.database.db.select({ id: workspaces.workspaceId }).from(workspaces)
    const registered = new Set(rows.map((r) => r.id))
    expect(registered.has(WS_SWEEP)).toBe(true)
    // WS_A is where most of this suite lives and has assets with warranties; it is deliberately not
    // registered, and this is what proves the sweep is bounded by the registry rather than by luck.
    expect(registered.has(WS_A)).toBe(false)
  })

  /**
   * Declared last on purpose: it registers a workspace of its own, and every `warranty-sweep` after
   * this point would sweep it too.
   */
  it('does not mark a notice nobody could be told about', async () => {
    // A workspace with no members at all, which is what "nobody holds `inventory.asset.manage`"
    // looks like from here — the audience comes from core, and core says there is nobody.
    await inventoryModule.onWorkspaceEnabled?.(WS_SILENT, kernel)
    const orphan = await createAsset(WS_SILENT, { name: 'Nobody’s scanner', warrantyUntil: inDays(7) })

    NOTIFICATIONS.length = 0
    await jobNamed('warranty-sweep')()
    expect(notificationsOfType('inventory.warranty.expiring')).toEqual([])

    const before = await kernel.database.withWorkspace(WS_SILENT, (tx) =>
      tx.select({ at: assets.warrantyNotifiedAt }).from(assets).where(eq(assets.id, orphan.id)),
    )
    // Marking it would lose the notice for ever, including for whoever is given the permission
    // tomorrow — which is what happens next.
    expect(before[0]?.at, 'nobody to tell is not the same as told').toBeNull()

    seedMember(WS_SILENT, OLIVE, 'admin', 'Olive Ferrer')
    await jobNamed('warranty-sweep')()
    expect(notificationsOfType('inventory.warranty.expiring').map((n) => n.userId)).toEqual([OLIVE])
    const after = await kernel.database.withWorkspace(WS_SILENT, (tx) =>
      tx.select({ at: assets.warrantyNotifiedAt }).from(assets).where(eq(assets.id, orphan.id)),
    )
    expect(after[0]?.at).not.toBeNull()
  })
})

describe('somebody leaving with company property', () => {
  const memberRemoved = defineEvent(
    'core.member.removed',
    z.object({ workspaceId: z.uuid(), userId: z.uuid() }),
  )
  const personStatusChanged = defineEvent(
    'hr.person.status_changed',
    z.object({
      workspaceId: z.uuid(),
      personId: z.uuid(),
      from: z.string(),
      to: z.string(),
      on: z.iso.date(),
    }),
  )

  let held: Asset

  beforeAll(async () => {
    seedMember(WS_LEAVER, OLIVE, 'admin', 'Olive Ferrer')
    seedMember(WS_LEAVER, DANA, 'member', 'Dana Okoro')
    held = await createAsset(WS_LEAVER, { name: 'Dana’s MacBook' }, OLIVE)
    await call(
      inv.custody.assign,
      { workspaceId: WS_LEAVER, assetId: held.id, userId: DANA },
      { context: asUser(OLIVE, WS_LEAVER) },
    )
  }, 60_000)

  /**
   * The HR-absent case runs first, and says so out loud.
   *
   * "Inert without HR" is a claim about a procedure nothing hosts, so the honest test is one where
   * nothing hosts it — not one where a stub pretends to fail. The assertion below is what stops
   * this passing vacuously if the file is ever reordered and `hr.*` is registered before it.
   */
  it('does nothing when HR is not installed anywhere on the instance', async () => {
    expect(kernel.broker.has('hr.person.get'), 'nothing hosts hr.* yet').toBe(false)
    NOTIFICATIONS.length = 0
    await kernel.emit(
      personStatusChanged,
      {
        workspaceId: WS_LEAVER,
        personId: randomUUID(),
        from: 'active',
        to: 'offboarding',
        on: inDays(0),
      },
      { workspaceId: WS_LEAVER },
    )
    expect(notificationsOfType('inventory.custody.return_due')).toEqual([])
  })

  it('raises the return list when core says a member was removed', async () => {
    NOTIFICATIONS.length = 0
    await kernel.emit(memberRemoved, { workspaceId: WS_LEAVER, userId: DANA }, { workspaceId: WS_LEAVER })

    const sent = notificationsOfType('inventory.custody.return_due')
    // Everybody who may take an item back, which by default is every member — and never the person
    // being chased, who is no longer in the workspace at all.
    expect(sent.map((n) => n.userId)).toEqual([OLIVE])
    // The person's name, never their uuid: a sentence with one in the middle is the product
    // admitting it does not know who it is talking about.
    expect(sent[0]?.title).toContain('Dana Okoro')
    expect(sent[0]?.title).not.toContain(DANA)
    expect(sent[0]?.body).toContain(held.code)
    expect(sent[0]?.url).toBe(`/inventory?asset=${held.id}`)
    expect(sent[0]?.data).toMatchObject({ userId: DANA, departure: 'removed' })
  })

  it('moves nothing: the item is still recorded as theirs, and the timeline is untouched', async () => {
    const asset = await call(
      inv.assets.get,
      { workspaceId: WS_LEAVER, assetId: held.id },
      { context: asUser(OLIVE, WS_LEAVER) },
    )
    expect(asset.custodianUserId, 'a hook must never write a handover nobody performed').toBe(DANA)
    expect(asset.status).toBe('assigned')

    const open = await kernel.database.withWorkspace(WS_LEAVER, (tx) =>
      tx.select().from(custodyPeriods).where(eq(custodyPeriods.assetId, held.id)),
    )
    expect(open.filter((p) => p.effectiveTo === null)).toHaveLength(1)

    const timeline = await call(
      inv.assets.history,
      { workspaceId: WS_LEAVER, assetId: held.id },
      { context: asUser(OLIVE, WS_LEAVER) },
    )
    expect(timeline.items.map((e) => e.action).sort()).toEqual(['assigned', 'created'])
  })

  it('raises it from HR’s own event once HR is running', async () => {
    const personId = randomUUID()
    PEOPLE.set(personId, { id: personId, userId: DANA, status: 'offboarding' })
    kernel.broker.register('hr', {
      'person.get': {
        handler: async (input: { personId: string }) => PEOPLE.get(input.personId) ?? null,
      },
    })

    NOTIFICATIONS.length = 0
    await kernel.emit(
      personStatusChanged,
      { workspaceId: WS_LEAVER, personId, from: 'active', to: 'offboarding', on: inDays(0) },
      { workspaceId: WS_LEAVER },
    )
    const sent = notificationsOfType('inventory.custody.return_due')
    expect(sent.map((n) => n.userId)).toEqual([OLIVE])
    expect(sent[0]?.data).toMatchObject({ userId: DANA, departure: 'leaving' })
  })

  it('ignores a status change that is not somebody leaving', async () => {
    const personId = randomUUID()
    PEOPLE.set(personId, { id: personId, userId: DANA, status: 'active' })
    NOTIFICATIONS.length = 0
    await kernel.emit(
      personStatusChanged,
      { workspaceId: WS_LEAVER, personId, from: 'onboarding', to: 'active', on: inDays(0) },
      { workspaceId: WS_LEAVER },
    )
    expect(notificationsOfType('inventory.custody.return_due')).toEqual([])
  })

  it('ignores a person with no Kern account behind them', async () => {
    const personId = randomUUID()
    PEOPLE.set(personId, { id: personId, userId: null, status: 'terminated' })
    NOTIFICATIONS.length = 0
    await kernel.emit(
      personStatusChanged,
      { workspaceId: WS_LEAVER, personId, from: 'active', to: 'terminated', on: inDays(0) },
      { workspaceId: WS_LEAVER },
    )
    expect(notificationsOfType('inventory.custody.return_due')).toEqual([])
  })

  it('says nothing in a workspace that has HR and not Inventory', async () => {
    // The event bus is instance-wide, so this handler is entered for every workspace on the
    // instance. One workspace having HR says nothing about another having Inventory.
    seedMember(WS_NO_INVENTORY, OLIVE, 'admin', 'Olive Ferrer')
    MODULE_OFF.add(WS_NO_INVENTORY)
    kernel.settings.invalidate(WS_NO_INVENTORY)
    try {
      const personId = randomUUID()
      PEOPLE.set(personId, { id: personId, userId: DANA, status: 'terminated' })
      NOTIFICATIONS.length = 0
      await kernel.emit(
        personStatusChanged,
        { workspaceId: WS_NO_INVENTORY, personId, from: 'active', to: 'terminated', on: inDays(0) },
        { workspaceId: WS_NO_INVENTORY },
      )
      expect(notificationsOfType('inventory.custody.return_due')).toEqual([])
    } finally {
      MODULE_OFF.delete(WS_NO_INVENTORY)
      kernel.settings.invalidate(WS_NO_INVENTORY)
    }
  })

  it('says nothing about somebody who was holding nothing', async () => {
    NOTIFICATIONS.length = 0
    await kernel.emit(memberRemoved, { workspaceId: WS_LEAVER, userId: OLIVE }, { workspaceId: WS_LEAVER })
    expect(notificationsOfType('inventory.custody.return_due')).toEqual([])
  })

  it('names every item when somebody holds several', async () => {
    const second = await createAsset(WS_LEAVER, { name: 'Docking station' }, OLIVE)
    await call(
      inv.custody.assign,
      { workspaceId: WS_LEAVER, assetId: second.id, userId: DANA },
      { context: asUser(OLIVE, WS_LEAVER) },
    )
    NOTIFICATIONS.length = 0
    await kernel.emit(memberRemoved, { workspaceId: WS_LEAVER, userId: DANA }, { workspaceId: WS_LEAVER })
    const [sent] = notificationsOfType('inventory.custody.return_due')
    expect(sent?.body).toContain(held.code)
    expect(sent?.body).toContain(second.code)
    // Several items have no single object worth pointing at, so the link is the return list.
    expect(sent?.url).toBe(`/inventory?custodian=${DANA}`)

    // And that list is a real answer: the same filter the page puts on the URL.
    const list = await call(
      inv.custody.byUser,
      { workspaceId: WS_LEAVER, userId: DANA },
      { context: asUser(OLIVE, WS_LEAVER) },
    )
    expect(list.items.map((a) => a.id).sort()).toEqual([held.id, second.id].sort())
  })
})

/**
 * The order a timeline is read in, and the ten random bytes that used to decide it.
 *
 * `asset_history` is newest-first, and it used to be ordered by its primary key on the reasoning
 * `assets.list` still gives for `sort: 'recent'` — a uuidv7 carries the clock, and it is unique
 * where `created_at` is not. Unique it is. Ordered it is only **to the millisecond**: the kernel's
 * `uuidv7()` fills bytes 6-15 from `randomUUID()` with no intra-millisecond counter, so two entries
 * written inside one millisecond sort by chance.
 *
 * It never broke paging, which is why it survived so long — the order is *stable* for a given set of
 * rows, so nothing was ever dropped or repeated. What it broke is the thing the record is for: a
 * timeline could render "Bruno removed the file" above "Bruno added the file", and a register whose
 * whole value is saying what happened in the order it happened was quietly lying about half of it.
 * The suite saw it as `attaching files > detaches one file and records it` failing about one run in
 * eight; a person would have seen it as the product being wrong.
 *
 * `asset_history.seq` is the fix — a sequence, exact rather than probabilistic — and these are the
 * tests that would have caught it. Twelve entries in one transaction share `created_at` exactly and
 * are written in a known order; the odds of ten random bytes reproducing that order twelve deep are
 * about one in half a billion, so this is not a flaky test pointed the other way.
 */
describe('the order an asset’s timeline is written in', () => {
  const ctx = () => ({ context: asUser(ALICE) })
  const STEPS = 12

  /**
   * Twelve entries, one transaction, one `now()`.
   *
   * Written through `NotifyService.history` — the same call every mutation in this module makes to
   * append to the trail — rather than through twelve procedures, because twelve procedures are
   * twelve transactions and the whole subject here is entries that share a timestamp.
   */
  const writeBurst = async (assetId: string) =>
    run(async (tx) => {
      const svc = inventoryServices(kernel)
      for (let step = 0; step < STEPS; step++)
        await svc.notify.history(tx, {
          workspaceId: WS_A,
          assetId,
          actorId: ALICE,
          action: `step_${String(step).padStart(2, '0')}`,
        })
    })

  const expected = Array.from({ length: STEPS }, (_, i) => `step_${String(STEPS - 1 - i).padStart(2, '0')}`)

  it('reads back newest first when every entry shares a timestamp', async () => {
    const item = await createAsset(WS_A, { name: 'Twelve things at once' })
    await writeBurst(item.id)

    const { items } = await call(
      inv.assets.history,
      { workspaceId: WS_A, assetId: item.id, limit: 50 },
      ctx(),
    )
    // The `created` entry the asset was born with is last, and everything above it is in reverse
    // write order — not in an order ten random bytes happened to agree on.
    expect(items.map((e) => e.action)).toEqual([...expected, 'created'])
  })

  it('keeps that order across page boundaries, and still repeats nothing', async () => {
    const item = await createAsset(WS_A, { name: 'Twelve things, two at a time' })
    await writeBurst(item.id)

    const seen: string[] = []
    const ids: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 20; guard++) {
      const page = await call(
        inv.assets.history,
        { workspaceId: WS_A, assetId: item.id, limit: 2, ...(cursor ? { cursor } : {}) },
        ctx(),
      )
      seen.push(...page.items.map((e) => e.action))
      ids.push(...page.items.map((e) => e.id))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(seen, 'twelve steps plus the creation').toEqual([...expected, 'created'])
    expect(new Set(ids).size, 'no entry repeated across a boundary').toBe(ids.length)
  })

  it('is a sequence rather than a clock: one transaction, twelve strictly increasing values', async () => {
    const item = await createAsset(WS_A, { name: 'Twelve sequence numbers' })
    await writeBurst(item.id)

    const rows = await run((tx) =>
      tx
        .select({ seq: assetHistory.seq, at: assetHistory.occurredAt, action: assetHistory.action })
        .from(assetHistory)
        .where(and(eq(assetHistory.workspaceId, WS_A), eq(assetHistory.assetId, item.id)))
        .orderBy(asc(assetHistory.seq)),
    )
    const burst = rows.filter((row) => row.action.startsWith('step_'))
    expect(burst).toHaveLength(STEPS)
    // The timestamps are identical — `now()` is the transaction's, which is exactly why they cannot
    // order anything — and the sequence numbers are consecutive and increasing.
    expect(new Set(burst.map((row) => row.at.toISOString())).size, 'one transaction, one now()').toBe(1)
    expect(burst.map((row) => row.action)).toEqual([...expected].reverse().map((action) => action))
    for (let i = 1; i < burst.length; i++)
      expect(burst[i]!.seq, 'strictly increasing').toBeGreaterThan(burst[i - 1]!.seq)
  })

  it('orders two separate transactions in the same millisecond, which is the flake that started this', async () => {
    /**
     * The reported failure, reduced.
     *
     * `attachments.add` and `attachments.remove` are two transactions, and on a warm connection they
     * land inside one millisecond often enough to fail about one run in eight. Ten attach/detach
     * pairs make that certain rather than likely: under the old ordering at least one pair would
     * come back the wrong way round with overwhelming probability.
     */
    const asset = await createAsset(WS_FILES, { name: 'Attached and detached ten times' })
    const user = () => ({ context: asUser(ALICE, WS_FILES) })
    for (let i = 0; i < 10; i++) {
      const fileId = seedFile(WS_FILES, `Receipt ${i}.pdf`)
      const [added] = await call(
        inv.attachments.add,
        { workspaceId: WS_FILES, assetId: asset.id, fileIds: [fileId] },
        user(),
      )
      await call(inv.attachments.remove, { workspaceId: WS_FILES, attachmentId: added!.id }, user())
    }

    const { items } = await call(
      inv.assets.history,
      { workspaceId: WS_FILES, assetId: asset.id, limit: 50 },
      user(),
    )
    const actions = items.map((e) => e.action)
    expect(actions).toEqual([
      ...Array.from({ length: 10 }, () => ['attachment_removed', 'attachment_added']).flat(),
      'created',
    ])
  })
})

/**
 * The timeline's page marker, which is a number rather than a row id now.
 *
 * It keeps the three properties the uuid bookmark has and for the same reasons — bounded, checked
 * before it reaches SQL, and bound to the sort it was issued under — and each of those is a defect
 * the *first* cursor format in this module actually shipped. A second bookmark format that only
 * looked validated would be a second set of them.
 */
describe('a page marker into a timeline', () => {
  const ctx = () => ({ context: asUser(ALICE) })
  const marker = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

  const paged = async (assetId: string, cursor: string) =>
    refusedWith(() => call(inv.assets.history, { workspaceId: WS_A, assetId, limit: 2, cursor }, ctx()))

  it('refuses everything that is not a sequence number this list issued', async () => {
    const item = await createAsset(WS_A, { name: 'Marker checks' })
    await call(inv.assets.update, { workspaceId: WS_A, assetId: item.id, location: 'Desk' }, ctx())

    const refusals = await Promise.all([
      // A row id, which is what the marker used to be — a cursor already in somebody's browser tab.
      paged(item.id, marker({ i: randomUUID(), s: 'recent' })),
      // A number wearing a string, which would reach a `bigint` comparison as a 22P02 nobody caught.
      paged(item.id, marker({ n: '3', s: 'recent' })),
      // Not an integer, not positive, and beyond what a double can represent exactly.
      paged(item.id, marker({ n: 2.5, s: 'recent' })),
      paged(item.id, marker({ n: 0, s: 'recent' })),
      paged(item.id, marker({ n: -1, s: 'recent' })),
      paged(item.id, marker({ n: 1e40, s: 'recent' })),
      // Issued under an ordering this list does not have.
      paged(item.id, marker({ n: 3, s: 'oldest' })),
      // Not a marker at all.
      paged(item.id, 'not-base64-json'),
    ])
    expect(refusals).toEqual(Array.from({ length: 8 }, () => 'BAD_REQUEST'))
  })

  it('issues one the contract can carry, and one that actually pages', async () => {
    const item = await createAsset(WS_A, { name: 'Marker size' })
    await call(inv.assets.update, { workspaceId: WS_A, assetId: item.id, location: 'Desk' }, ctx())

    const first = await call(inv.assets.history, { workspaceId: WS_A, assetId: item.id, limit: 1 }, ctx())
    expect(first.nextCursor).toBeTruthy()
    // `Cursor` is `max(512)` in the contract, and the old sort-key cursor broke that on a long
    // Persian name. This one is the same handful of bytes whatever the row.
    expect(() => Cursor.parse(first.nextCursor)).not.toThrow()
    expect(first.nextCursor!.length).toBeLessThan(64)

    const second = await call(
      inv.assets.history,
      { workspaceId: WS_A, assetId: item.id, limit: 1, cursor: first.nextCursor! },
      ctx(),
    )
    expect(second.items.map((e) => e.action)).toEqual(['created'])
    expect(second.nextCursor, 'and it ends rather than looping').toBeNull()
  })
})

/**
 * The other foreign id an asset carries, and the one that was still taken on trust.
 *
 * `photoFileId` was checked against core; `categoryId` was not checked against anything, so any uuid
 * at all went into the column. Two ways that goes wrong and neither needs an attacker: an id from
 * **another workspace** files an asset under a category this one cannot see, name or unfile — the
 * picker builds its `id → name` map from this workspace's own `categories.list`, so the field renders
 * blank and the filter behind it offers nothing that matches — and an id belonging to **nobody** does
 * the same with no second workspace involved. Either way the register holds a reference to a row that
 * is not there, which is the exact state `categories.archive` exists to prevent from the other end.
 */
describe('filing an asset under a category', () => {
  const ctx = () => ({ context: asUser(ALICE, WS_CAT) })

  it('refuses one belonging to another workspace, and one belonging to nobody', async () => {
    const theirs = await call(
      inv.categories.create,
      { workspaceId: WS_A, name: 'Somebody else’s filing' },
      { context: asUser(ALICE, WS_A) },
    )
    const refusals = await Promise.all([
      refusedWith(() =>
        call(
          inv.assets.create,
          { workspaceId: WS_CAT, name: 'Borrowed filing', categoryId: theirs.id },
          ctx(),
        ),
      ),
      refusedWith(() =>
        call(
          inv.assets.create,
          { workspaceId: WS_CAT, name: 'Filed under nothing', categoryId: randomUUID() },
          ctx(),
        ),
      ),
    ])
    expect(refusals).toEqual(['BAD_REQUEST', 'BAD_REQUEST'])
  })

  it('refuses one on an edit as well, and leaves the asset filed where it was', async () => {
    const ours = await call(inv.categories.create, { workspaceId: WS_CAT, name: 'Ours to file under' }, ctx())
    const asset = await call(
      inv.assets.create,
      { workspaceId: WS_CAT, name: 'Correctly filed', categoryId: ours.id },
      ctx(),
    )
    const theirs = await call(
      inv.categories.create,
      { workspaceId: WS_A, name: 'Not for this workspace' },
      { context: asUser(ALICE, WS_A) },
    )

    expect(
      await refusedWith(() =>
        call(inv.assets.update, { workspaceId: WS_CAT, assetId: asset.id, categoryId: theirs.id }, ctx()),
      ),
    ).toBe('BAD_REQUEST')
    expect(
      await refusedWith(() =>
        call(inv.assets.update, { workspaceId: WS_CAT, assetId: asset.id, categoryId: randomUUID() }, ctx()),
      ),
    ).toBe('BAD_REQUEST')

    const after = await call(inv.assets.get, { workspaceId: WS_CAT, assetId: asset.id }, ctx())
    expect(after.categoryId, 'a refused edit changes nothing').toBe(ours.id)
  })

  it('takes an archived one of its own, because archiving is not deleting', async () => {
    const retired = await call(inv.categories.create, { workspaceId: WS_CAT, name: 'Tidied away' }, ctx())
    await call(inv.categories.archive, { workspaceId: WS_CAT, categoryId: retired.id, archived: true }, ctx())
    // The row still exists and every asset already filed under it still names it, so refusing here
    // would mean an edit to an asset's location failing over a category somebody tidied last year.
    const asset = await call(
      inv.assets.create,
      { workspaceId: WS_CAT, name: 'Filed under something archived', categoryId: retired.id },
      ctx(),
    )
    expect(asset.categoryId).toBe(retired.id)
  })

  it('still lets a patch that never mentions a category through, and one that clears it', async () => {
    const ours = await call(inv.categories.create, { workspaceId: WS_CAT, name: 'Left alone' }, ctx())
    const asset = await call(
      inv.assets.create,
      { workspaceId: WS_CAT, name: 'Renamed, not refiled', categoryId: ours.id },
      ctx(),
    )
    const renamed = await call(
      inv.assets.update,
      { workspaceId: WS_CAT, assetId: asset.id, name: 'Renamed properly' },
      ctx(),
    )
    expect(renamed.categoryId, '`undefined` is "not mentioned", not "check this"').toBe(ours.id)

    const cleared = await call(
      inv.assets.update,
      { workspaceId: WS_CAT, assetId: asset.id, categoryId: null },
      ctx(),
    )
    expect(cleared.categoryId, 'and `null` is "unfile it", which is not an id to check').toBeNull()
  })
})

/**
 * A date somebody types that quietly switches a safety net off.
 *
 * `sentOn` had no upper bound, and the overdue sweep looks for `sent_on <= today - repairOverdueDays`
 * — so a repair dated 2030 is outside that window *for ever*. Not chased late: never chased, silently,
 * because a sweep that finds nothing looks exactly like a sweep with nothing to do. It is also the
 * one field that decides whether anybody is ever reminded that a vendor still has the company's
 * laptop, which is what makes a typo here expensive and a deliberate one worse.
 *
 * The bound is a day past UTC-today, because `RepairService.today()` is UTC and a workspace in
 * Auckland spends much of its working day in UTC's tomorrow.
 */
describe('the day a repair says it was sent', () => {
  const ctx = () => ({ context: asUser(ALICE, WS_REPAIR) })
  const inDaysFromToday = (days: number): string => {
    const d = new Date()
    d.setUTCDate(d.getUTCDate() + days)
    return d.toISOString().slice(0, 10)
  }

  it('refuses a send date in the future', async () => {
    const asset = await createAsset(WS_REPAIR, { name: 'Sent next decade' })
    expect(
      await refusedWith(() =>
        call(
          inv.repairs.create,
          { workspaceId: WS_REPAIR, assetId: asset.id, summary: 'Screen', sentOn: '2030-01-01' },
          ctx(),
        ),
      ),
    ).toBe('BAD_REQUEST')
    // And nothing was written, so the asset is still where it was.
    expect(await statusOf(WS_REPAIR, asset.id)).toBe('in_stock')
  })

  it('allows the one day of grace a workspace ahead of UTC needs, and refuses the next', async () => {
    const ahead = await createAsset(WS_REPAIR, { name: 'Sent in Auckland' })
    const { repair } = await sendForRepair(WS_REPAIR, ahead.id, {
      summary: 'Keyboard',
      sentOn: inDaysFromToday(1),
    })
    expect(repair.sentOn).toBe(inDaysFromToday(1))

    const beyond = await createAsset(WS_REPAIR, { name: 'Sent the day after that' })
    expect(
      await refusedWith(() =>
        call(
          inv.repairs.create,
          { workspaceId: WS_REPAIR, assetId: beyond.id, summary: 'Fan', sentOn: inDaysFromToday(2) },
          ctx(),
        ),
      ),
    ).toBe('BAD_REQUEST')
  })

  it('refuses an edit that moves the date into the future, and leaves the row alone', async () => {
    const asset = await createAsset(WS_REPAIR, { name: 'Re-dated into 2030' })
    const { repair } = await sendForRepair(WS_REPAIR, asset.id, {
      summary: 'Hinge',
      sentOn: inDaysFromToday(-40),
    })
    expect(
      await refusedWith(() =>
        call(
          inv.repairs.update,
          { workspaceId: WS_REPAIR, repairId: repair.id, sentOn: '2030-06-01' },
          ctx(),
        ),
      ),
    ).toBe('BAD_REQUEST')

    const [row] = await kernel.database.withWorkspace(WS_REPAIR, (tx) =>
      tx
        .select({ sentOn: repairs.sentOn })
        .from(repairs)
        .where(and(eq(repairs.workspaceId, WS_REPAIR), eq(repairs.id, repair.id))),
    )
    expect(row?.sentOn, 'a refused edit writes nothing').toBe(inDaysFromToday(-40))
  })

  it('leaves the overdue sweep able to find one that was dated properly', async () => {
    // The point of the bound, stated as the behaviour it protects rather than as the refusal.
    const asset = await createAsset(WS_REPAIR, { name: 'Findable by the sweep' })
    const { repair } = await sendForRepair(WS_REPAIR, asset.id, {
      summary: 'Battery',
      sentOn: inDaysFromToday(-60),
    })
    const found = await kernel.database.withWorkspace(WS_REPAIR, (tx) =>
      tx
        .select({ id: repairs.id })
        .from(repairs)
        .where(
          and(
            eq(repairs.workspaceId, WS_REPAIR),
            eq(repairs.id, repair.id),
            sql`${repairs.sentOn} <= ${inDaysFromToday(-14)}::date`,
          ),
        ),
    )
    expect(found).toHaveLength(1)
  })
})

/**
 * Switching a capability off must not trap what is behind it.
 *
 * A capability is a boolean in module settings: switching it off hides a surface and answers 404, and
 * switching it back on has to find everything exactly where it was. `repairs` broke the second half
 * of that. An item that was away when the switch went off stayed `under_repair` for ever — the only
 * procedure that can close a repair answers 404 — and `assets.archive` refused to retire it *because*
 * it was away, with a sentence telling the person to go and use the procedure that answers 404. Two
 * refusals pointing at each other, and an asset the workspace could not get out of either.
 *
 * The rule now is that a capability which is off makes its facts inert: `under_repair` belongs to
 * `repairs`, so a workspace without it has no asset in that status, and no refusal may cite a repair
 * the workspace cannot reach. Nothing is destroyed to achieve it — the repair rows sit untouched, and
 * switching back on brings the status back with them.
 */
describe('a workspace that switches repairs off with one still open', () => {
  const on = () => ({ context: asUser(ALICE, WS_STRAND) })
  const withRepairsOff = (fn: () => Promise<void>) => withCapabilities({ repairs: false }, fn, [WS_STRAND])

  it('lets the item be archived, where the refusal used to point at a 404', async () => {
    const asset = await createAsset(WS_STRAND, { name: 'Away when the switch went off' })
    await sendForRepair(WS_STRAND, asset.id, { summary: 'Cracked panel' })
    expect(await statusOf(WS_STRAND, asset.id)).toBe('under_repair')

    // While repairs are still on, the refusal stands and means something: the two-step instruction
    // it gives is one the workspace can actually follow.
    expect(
      await refusedWith(() =>
        call(inv.assets.archive, { workspaceId: WS_STRAND, assetId: asset.id, archived: true }, on()),
      ),
    ).toBe('CONFLICT')

    await withRepairsOff(async () => {
      const archived = await call(
        inv.assets.archive,
        { workspaceId: WS_STRAND, assetId: asset.id, archived: true },
        { context: asUser(ALICE, WS_STRAND) },
      )
      expect(archived.archivedAt).not.toBeNull()
    })

    // Switched back on: the repair is still open, still says what it said, and can still be closed.
    const { items } = await call(inv.repairs.list, { workspaceId: WS_STRAND, assetId: asset.id }, on())
    expect(items.map((r) => ({ summary: r.summary, returnedOn: r.returnedOn }))).toEqual([
      { summary: 'Cracked panel', returnedOn: null },
    ])
    const { asset: back } = await completeRepair(WS_STRAND, items[0]!.id)
    expect(back.status, 'and completing it still derives a status').toBe('in_stock')
  })

  it('takes the item out of `under_repair` the next time anybody touches it', async () => {
    const asset = await createAsset(WS_STRAND, { name: 'Handed over while repairs were off' })
    await sendForRepair(WS_STRAND, asset.id, { summary: 'Fan' })
    expect(await statusOf(WS_STRAND, asset.id)).toBe('under_repair')

    await withRepairsOff(async () => {
      const { asset: handed } = await call(
        inv.custody.assign,
        { workspaceId: WS_STRAND, assetId: asset.id, userId: BOB },
        { context: asUser(ALICE, WS_STRAND) },
      )
      // `under_repair` is a status the `repairs` capability owns. Without it the item is simply
      // Bob's — which is the whole truth this workspace still records about where it is.
      expect({ status: handed.status, holder: handed.custodianUserId }).toEqual({
        status: 'assigned',
        holder: BOB,
      })
    })

    // And on again: the repair is still open, so the next thing that touches the asset says so.
    const { asset: after } = await call(
      inv.custody.return,
      { workspaceId: WS_STRAND, assetId: asset.id },
      on(),
    )
    expect({ status: after.status, holder: after.custodianUserId }).toEqual({
      status: 'under_repair',
      holder: null,
    })
  })

  it('reconciles the spare in the cupboard that nobody touches, in both directions', async () => {
    /**
     * `reconcileStatuses` called directly rather than through `repair-overdue`, and deliberately.
     *
     * The job resolves the capability per workspace from core, and the stub answering core here is
     * instance-wide — so running the whole job with `repairs: false` in force would restamp every
     * *other* workspace in this suite as a side effect of testing this one. The function takes the
     * switch as an argument for exactly the reason the services do, which also makes both directions
     * assertable without touching the switchboard at all.
     */
    const asset = await createAsset(WS_STRAND, { name: 'Left in the cupboard' })
    await sendForRepair(WS_STRAND, asset.id, { summary: 'Power supply' })
    expect(await statusOf(WS_STRAND, asset.id)).toBe('under_repair')

    expect(await reconcileStatuses(kernel, WS_STRAND, false), 'one row was wrong').toBeGreaterThan(0)
    expect(await statusOf(WS_STRAND, asset.id)).toBe('in_stock')
    expect(await reconcileStatuses(kernel, WS_STRAND, false), 'and now nothing is').toBe(0)

    // Back on, without anybody having touched the asset in between.
    expect(await reconcileStatuses(kernel, WS_STRAND, true)).toBeGreaterThan(0)
    expect(await statusOf(WS_STRAND, asset.id)).toBe('under_repair')
    expect(await reconcileStatuses(kernel, WS_STRAND, true)).toBe(0)
  })

  it('never overwrites a status this module does not derive', async () => {
    // `reserved`, `lost` and `retired` are set by hand by features that do not exist yet. A nightly
    // reconciliation that stamped over one would silently undo somebody's decision.
    const asset = await createAsset(WS_STRAND, { name: 'Written off by hand' })
    await kernel.database.withWorkspace(WS_STRAND, (tx) =>
      tx
        .update(assets)
        .set({ status: 'lost' })
        .where(and(eq(assets.workspaceId, WS_STRAND), eq(assets.id, asset.id))),
    )
    // Both directions, and `true` last so this test leaves the workspace as it found it — the
    // reconciliation is workspace-wide by design, so running it with `repairs` off would release
    // every other asset in here and the count test below would be asserting about its own leftovers.
    await reconcileStatuses(kernel, WS_STRAND, false)
    await reconcileStatuses(kernel, WS_STRAND, true)
    expect(await statusOf(WS_STRAND, asset.id)).toBe('lost')
  })

  it('keeps the two counts of what is away in step once an archived row can have one', async () => {
    /**
     * `stats.byStatus.under_repair` counts live rows by their cached status; `outForRepair` counts
     * repair rows. They were kept equal by `assets.archive` refusing to retire an item that is away —
     * the refusal that has just been withdrawn while the capability is off. So `away()` joins to the
     * asset now, and this is the state that would otherwise have made them disagree.
     */
    const stats = await call(inv.stats.summary, { workspaceId: WS_STRAND }, on())
    expect(stats.outForRepair, 'the archived one from the first test is not counted').toBe(
      stats.byStatus.under_repair,
    )
  })
})

/**
 * The other half of the lost-update fix, which nothing was holding.
 *
 * `assets.status` is derived from two facts written by two different services: custody, and the open
 * repair. Each used to read the other's fact without a lock, so a handover and a repair committing at
 * the same instant interleaved into a status matching neither — the second writer derived from a
 * snapshot that had already stopped being true and wrote it over the first one's answer.
 *
 * `CustodyService.stamp` takes the lock and three tests fail without it. `RepairService.restamp`
 * takes the same lock and **nothing failed without it**, because every existing test that races the
 * two puts the repair first: a repair that is open dominates the derivation, so a stale custodian
 * cannot change the answer. The interleaving that exposes it is the other way round — a repair being
 * *completed* while a handover commits, where the status the repair writes is decided entirely by a
 * custodian it read before the handover existed.
 */
describe('a repair coming back as the item changes hands', () => {
  it('does not put an item in stock that somebody has just been handed', async () => {
    const svc = inventoryServices(kernel)
    const item = await createAsset(WS_CUSTODY, { name: 'Back from the workshop, into Bob’s hands' })
    const { repair } = await call(
      inv.repairs.create,
      { workspaceId: WS_CUSTODY, assetId: item.id, summary: 'Screen' },
      { context: asUser(ALICE, WS_CUSTODY) },
    )

    let handed!: () => void
    const done = new Promise<void>((resolve) => {
      handed = resolve
    })
    let commitHandover!: () => void
    const holdHandover = new Promise<void>((resolve) => {
      commitHandover = resolve
    })

    // The handover goes first and holds: it has written `custodian_user_id = BOB` and holds the
    // asset row's lock, uncommitted.
    const handing = kernel.database.withWorkspace(
      WS_CUSTODY,
      async (tx) => {
        await svc.custody.assign(tx, WS_CUSTODY, ALICE, item.id, BOB, null, RECORDS_REPAIRS)
        handed()
        await holdHandover
      },
      { userId: ALICE },
    )
    await done

    /**
     * The completion reads the asset with a plain select before it writes — so it sees the custodian
     * as it was *before* the handover, which is nobody. Then `restamp` asks for the lock and waits.
     *
     * Without that lock it would derive `in_stock` from the stale row and write it over the
     * handover's `assigned`: Bob holding a laptop the register says is in the cupboard, which is the
     * one question the register exists to answer.
     */
    const finishing = kernel.database.withWorkspace(
      WS_CUSTODY,
      (tx) => svc.repairs.complete(tx, WS_CUSTODY, ALICE, repair.id, {}),
      { userId: ALICE },
    )
    const finished = finishing.then(
      () => null,
      (err: unknown) => err,
    )

    await waitForBlockedBackend()
    commitHandover()
    await handing
    expect(await finished, 'a handover never refuses a completion').toBeNull()

    const after = await call(
      inv.assets.get,
      { workspaceId: WS_CUSTODY, assetId: item.id },
      { context: asUser(ALICE, WS_CUSTODY) },
    )
    expect({ status: after.status, holder: after.custodianUserId }).toEqual({
      status: 'assigned',
      holder: BOB,
    })
  })
})

/**
 * Two people taking the same item back at once.
 *
 * `CustodyService.close` writes `effective_to` with `and effective_to is null` in its predicate, and
 * that clause is the optimistic guard: under READ COMMITTED the second transaction blocks on the row
 * lock, and when it resumes the row no longer matches, so zero rows come back rather than a second
 * close silently overwriting the first one's timestamp. It was real and nothing tested it — removing
 * the clause broke no test at all, which is the same shape of gap as the lock above.
 *
 * What it prevents is not an exotic state: a second `returned` entry in the timeline for a return
 * that happened once, and a period whose end is whichever of two transactions finished last.
 */
describe('two people taking the same item back at once', () => {
  it('lets exactly one close the period, and tells the other to look again', async () => {
    const svc = inventoryServices(kernel)
    const item = await createAsset(WS_CUSTODY, { name: 'Handed back twice' })
    await call(
      inv.custody.assign,
      { workspaceId: WS_CUSTODY, assetId: item.id, userId: BOB },
      { context: asUser(ALICE, WS_CUSTODY) },
    )

    let closed!: () => void
    const done = new Promise<void>((resolve) => {
      closed = resolve
    })
    let commitFirst!: () => void
    const holdFirst = new Promise<void>((resolve) => {
      commitFirst = resolve
    })

    const first = kernel.database.withWorkspace(
      WS_CUSTODY,
      async (tx) => {
        await svc.custody.return(tx, WS_CUSTODY, ALICE, item.id, null, RECORDS_REPAIRS)
        closed()
        await holdFirst
      },
      { userId: ALICE },
    )
    await done

    // The second one reads the period as still open — the close above is uncommitted, so it
    // genuinely is — and blocks on the row when it tries to close it too.
    const second = kernel.database.withWorkspace(
      WS_CUSTODY,
      (tx) => svc.custody.return(tx, WS_CUSTODY, OLIVE, item.id, null, RECORDS_REPAIRS),
      { userId: OLIVE },
    )
    const settled = second.then(
      () => null,
      (err: unknown) => err,
    )

    await waitForBlockedBackend()
    commitFirst()
    await first

    const reason = await settled
    expect(reason, 'the second close must lose').not.toBeNull()
    expect(codeOf(reason), 'a lost race is a conflict, not an unhandled 500').toBe('CONFLICT')
    expect(messageOf(reason)).not.toMatch(/failed query/i)
    expect(messageOf(reason), 'and it says what to do about it').toMatch(/reload/i)

    // One return, one closed period, one timeline entry saying so.
    const periods = await call(
      inv.custody.history,
      { workspaceId: WS_CUSTODY, assetId: item.id },
      { context: asUser(ALICE, WS_CUSTODY) },
    )
    expect(periods).toHaveLength(1)
    expect(periods[0]?.effectiveTo).not.toBeNull()
    const { items } = await call(
      inv.assets.history,
      { workspaceId: WS_CUSTODY, assetId: item.id, limit: 10 },
      { context: asUser(ALICE, WS_CUSTODY) },
    )
    expect(
      items.filter((e) => e.action === 'returned'),
      'one return, not two',
    ).toHaveLength(1)
  })

  it('refuses a return on an archived item, so there is no back door to undo one', async () => {
    /**
     * `CustodyService.stamp`'s comment used to say the opposite — that a return is deliberately let
     * past the archived check so an item that had reached the impossible state could be handed back.
     * It is not, and it never was: `return` calls `asset()` first, and `asset()` refuses an archived
     * row whichever verb asked. The narrowing in `stamp` is about a *handover* racing an archive, and
     * this is the test that stops the comment drifting away from the code again.
     */
    const item = await createAsset(WS_CUSTODY, { name: 'Retired and then handed back' })
    await call(
      inv.assets.archive,
      { workspaceId: WS_CUSTODY, assetId: item.id, archived: true },
      { context: asUser(ALICE, WS_CUSTODY) },
    )
    const refusal = await refusedWith(() =>
      call(
        inv.custody.return,
        { workspaceId: WS_CUSTODY, assetId: item.id },
        { context: asUser(ALICE, WS_CUSTODY) },
      ),
    )
    expect(refusal).toBe('CONFLICT')
  })
})
