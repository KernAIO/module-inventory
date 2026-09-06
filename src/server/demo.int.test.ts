import { randomUUID } from 'node:crypto'
import type { core, Principal } from '@kernhq/contracts'
import { createKernel, type Kernel } from '@kernhq/kernel'
import { eq } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seedInventoryDemo } from './demo.js'
import { inventoryModule } from './index.js'
import { assets, categories, custodyPeriods, fieldDefs, repairs } from './schema.js'

/**
 * The demo seeder, run against a real Postgres.
 *
 * Type-checking a seeder proves nothing about it: every interesting thing it can get wrong — a
 * required column, a constraint, a service that refuses what it was handed — only appears when the
 * SQL reaches a database. So this runs it, counts what it left, and then runs it again to prove the
 * second delivery of an at-least-once event does not double the workspace's contents.
 */

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB_NAME = `kern_inv_demo_${Date.now().toString(36)}`

let kernel: Kernel
let admin: pg.Client

const WS = randomUUID()
const OWNER = randomUUID()

const actor = (): Principal =>
  ({
    kind: 'service',
    userId: OWNER,
    email: null,
    name: 'service:test',
    locale: 'en',
    instanceAdmin: true,
    service: 'test',
    memberships: [],
    permissionVersion: 0,
  }) as unknown as Principal

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB_NAME}"`)
  const url = new URL(BASE_URL)
  url.pathname = `/${DB_NAME}`

  kernel = await createKernel({
    service: 'inventory-demo-test',
    modules: [inventoryModule],
    role: 'api',
    env: {
      DATABASE_URL: url.toString(),
      KERN_SECRET: 'test-secret-that-is-long-enough-for-kern',
      NODE_ENV: 'test',
      NATS_URL: undefined,
      VALKEY_URL: undefined,
    },
  })
  // The seeder reaches core for module settings (the code format) and announces what it writes.
  kernel.broker.register('core', {
    'activity.record': { handler: async () => ({ ok: true }) },
    'notifications.create': { handler: async () => ({ ok: true }) },
    'search.index': { handler: async (_i: { documents: core.SearchDocument[] }) => ({ ok: true }) },
    'search.remove': { handler: async () => ({ ok: true }) },
    'modules.isEnabled': { handler: async () => true },
    'settings.getModule': { handler: async () => ({}) },
    'authz.customRolePermissions': { handler: async () => [] },
    'authz.bindings': { handler: async () => [] },
    'workspaces.members': { handler: async () => [] },
  })
  await kernel.start()
  await inventoryModule.onWorkspaceEnabled?.(WS, kernel)
}, 180_000)

afterAll(async () => {
  await kernel?.stop().catch(() => undefined)
  await admin.query(`drop database if exists "${DB_NAME}" with (force)`).catch(() => undefined)
  await admin.end().catch(() => undefined)
})

describe('the demo seeder', () => {
  it('fills an empty workspace', async () => {
    const summary = await seedInventoryDemo({
      kernel,
      workspaceId: WS,
      actorId: OWNER,
      actor: actor(),
      now: new Date(),
    })
    expect(summary.skipped).toBeFalsy()
    expect(summary.created?.assets).toBeGreaterThan(30)

    const rows = await kernel.database.withWorkspace(WS, async (tx) => ({
      assets: await tx.select().from(assets).where(eq(assets.workspaceId, WS)),
      categories: await tx.select().from(categories).where(eq(categories.workspaceId, WS)),
      fields: await tx.select().from(fieldDefs).where(eq(fieldDefs.workspaceId, WS)),
      custody: await tx.select().from(custodyPeriods).where(eq(custodyPeriods.workspaceId, WS)),
      repairs: await tx.select().from(repairs).where(eq(repairs.workspaceId, WS)),
    }))

    // Five arrive from `onWorkspaceEnabled` and the seeder adds only what is missing — Peripherals
    // and Networking — rather than a second "Laptops".
    expect(rows.categories.map((c) => c.name).sort()).toEqual([
      'Furniture',
      'Laptops',
      'Monitors',
      'Networking',
      'Peripherals',
      'Phones',
      'Vehicles',
    ])
    expect(rows.fields.length).toBe(3)
    expect(rows.assets.length).toBe(summary.created?.assets)
    // Every item is filed and coded: an asset with no category or no code is what the register
    // looks like when a seeder wrote rows instead of using the service.
    expect(rows.assets.every((a) => a.categoryId)).toBe(true)
    expect(rows.assets.every((a) => a.code)).toBe(true)
    // Custody is a period, not a column. Three items are handed over.
    expect(rows.custody.length).toBe(3)
    expect(rows.custody.every((c) => c.userId === OWNER)).toBe(true)
    expect(rows.repairs.length).toBe(2)
  })

  /*
   * The case the first version of these seeders got wrong: the emptiness guard left `workspace_id`
   * to row-level security, so on any database whose owner can bypass a policy it saw the previous
   * workspace's assets and skipped. This test database connects as a superuser, which is exactly
   * that kind, so a second workspace is the cheapest reproduction there is.
   */
  it('stocks a second workspace in the same database', async () => {
    const other = randomUUID()
    await inventoryModule.onWorkspaceEnabled?.(other, kernel)
    const summary = await seedInventoryDemo({
      kernel,
      workspaceId: other,
      actorId: OWNER,
      actor: actor(),
      now: new Date(),
    })
    expect(summary.skipped).toBeFalsy()
    const rows = await kernel.database.withWorkspace(other, (tx) =>
      tx.select().from(assets).where(eq(assets.workspaceId, other)),
    )
    expect(rows.length).toBe(summary.created?.assets)
  })

  it('leaves a workspace that already holds something alone', async () => {
    const before = await kernel.database.withWorkspace(WS, (tx) =>
      tx.select().from(assets).where(eq(assets.workspaceId, WS)),
    )
    const summary = await seedInventoryDemo({
      kernel,
      workspaceId: WS,
      actorId: OWNER,
      actor: actor(),
      now: new Date(),
    })
    expect(summary.skipped).toBe(true)
    const after = await kernel.database.withWorkspace(WS, (tx) =>
      tx.select().from(assets).where(eq(assets.workspaceId, WS)),
    )
    expect(after.length).toBe(before.length)
  })
})
