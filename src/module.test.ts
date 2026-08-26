/**
 * This module's guard rails. Keep this file: it is what stops the contract and the router drifting.
 *
 * It needs no database and no running service: it walks the contract and the router as data and
 * checks the two things that are easy to forget and impossible for `tsc` to see.
 *
 *   1. every procedure the contract promises is actually implemented — a contract entry with no
 *      router entry type-checks perfectly and 404s at runtime;
 *   2. every implemented procedure is behind `workspaceScoped()` *and* a `requires()` — a procedure
 *      that forgets the second one is readable by any member of any workspace with the module on.
 *
 * Add your module's real tests next to it; this one keeps working as the contract grows.
 */
import type { Kernel } from '@kernhq/kernel'
import { describe, expect, it } from 'vitest'
import {
  inventoryCapabilities,
  inventoryCapabilityProcedures,
  inventoryContract,
  inventoryEvents,
  inventoryPermissions,
  MODULE_ID,
} from './contract/index.js'
import { inventoryModule } from './server/index.js'
import { inventoryRouter } from './server/router.js'

/** An oRPC procedure (contract or implementation) carries `~orpc`; a router group does not. */
interface Leaf {
  '~orpc': {
    route?: { method?: string; path?: string }
    middlewares?: unknown[]
  }
}
const isLeaf = (node: unknown): node is Leaf => typeof node === 'object' && node !== null && '~orpc' in node

/** `{ widgets: { list, create } }` → `{ 'widgets.list': leaf, 'widgets.create': leaf }` */
function leaves(node: unknown, path: string[] = []): Record<string, Leaf> {
  if (isLeaf(node)) return { [path.join('.')]: node }
  if (typeof node !== 'object' || node === null) return {}
  return Object.entries(node).reduce<Record<string, Leaf>>(
    (acc, [key, value]) => Object.assign(acc, leaves(value, [...path, key])),
    {},
  )
}

// The router is only inspected, never called, so it needs no real kernel behind it.
const declared = leaves(inventoryContract)
const implemented = leaves(inventoryRouter({} as Kernel))

describe('the contract and the router agree', () => {
  it('implements every declared procedure, and nothing that was never declared', () => {
    expect(Object.keys(implemented).sort()).toEqual(Object.keys(declared).sort())
  })

  it('keeps the REST route the contract published', () => {
    for (const [name, leaf] of Object.entries(implemented)) {
      const contractRoute = declared[name]?.['~orpc'].route
      expect(leaf['~orpc'].route?.method, `${name} method`).toBe(contractRoute?.method)
      expect(leaf['~orpc'].route?.path, `${name} path`).toBe(contractRoute?.path)
    }
  })
})

/**
 * Which middleware is which — established by what each one *does*, because there is nothing else to
 * go on.
 *
 * `workspaceScoped`, `requiresCapability` and `requires` all come back from oRPC as a function
 * named `decorated` carrying identical own properties: no name, no tag, nothing to compare. So each
 * middleware is called here against a kernel stub that records what it reached for, and what it
 * reached for is its identity.
 *
 * This is what replaced `middlewares.length >= 2`, which was satisfied by *any* two middlewares —
 * a procedure that had lost `workspaceScoped` and kept two permission checks passed it, and that is
 * precisely the failure this file's docblock claims to prevent. A count is not an assertion about
 * authorisation; it is an assertion about arithmetic.
 */
interface Reached {
  /** the module id `workspaceScoped` asked `isModuleEnabled` about */
  module?: string
  /** the permission `requires` asked `authz.require` for */
  permission?: string
  /** the `<module>.<capability>` `requiresCapability` looked up */
  capability?: string
}

type MiddlewareFn = (
  options: { context: unknown; next: (options?: unknown) => Promise<unknown> },
  input: unknown,
) => Promise<unknown>

const WORKSPACE = '00000000-0000-4000-8000-000000000000'

async function reachedFor(middleware: unknown): Promise<Reached> {
  const seen: Reached = {}
  const kernel = {
    authz: {
      requireMember: () => undefined,
      require: async (_principal: unknown, permission: string) => {
        seen.permission = permission
      },
    },
    isModuleEnabled: async (_workspaceId: string, moduleId: string) => {
      seen.module = moduleId
      return true
    },
    // The real one answers a Set; a stub only has to record which capability was asked about.
    capabilities: async (_workspaceId: string, moduleId: string) => ({
      has: (capability: string) => {
        seen.capability = `${moduleId}.${capability}`
        return true
      },
    }),
  }
  const principal = { kind: 'user', userId: WORKSPACE, instanceAdmin: false, memberships: [] }
  await (middleware as MiddlewareFn)(
    { context: { kernel, principal }, next: async () => ({}) },
    { workspaceId: WORKSPACE },
  )
  return seen
}

const chainOf = (name: string): unknown[] => implemented[name]?.['~orpc'].middlewares ?? []

describe('every procedure is authorised', () => {
  const declaredKeys = new Set(inventoryPermissions.map((p) => p.key))

  it('puts the workspace and module gate first, on every procedure', async () => {
    for (const name of Object.keys(implemented)) {
      const [first] = chainOf(name)
      expect(
        first === undefined ? undefined : (await reachedFor(first)).module,
        `${name}: the first middleware has to be workspaceScoped('${MODULE_ID}') — a real membership, and the module switched on for that workspace`,
      ).toBe(MODULE_ID)
    }
  })

  it('puts a permission check the module declares after it', async () => {
    for (const name of Object.keys(implemented)) {
      const asked = (await Promise.all(chainOf(name).slice(1).map(reachedFor)))
        .map((r) => r.permission)
        .filter((p) => p !== undefined)
      expect(
        asked.filter((p) => declaredKeys.has(p)),
        `${name}: needs requires(<a permission this module declares>) after the workspace gate; it asked for ${JSON.stringify(asked)}`,
      ).not.toHaveLength(0)
    }
  })
})

describe('the module declares what it uses', () => {
  it('names its permissions and events under its own module id', () => {
    for (const p of inventoryPermissions) expect(p.key.startsWith(`${MODULE_ID}.`), p.key).toBe(true)
    for (const e of Object.values(inventoryEvents))
      expect(e.name.startsWith(`${MODULE_ID}.`), e.name).toBe(true)
  })

  it('registers those permissions and events on the server module', () => {
    expect(inventoryModule.definition.id).toBe(MODULE_ID)
    expect(inventoryModule.definition.permissions).toBe(inventoryPermissions)
    expect(inventoryModule.definition.events).toBe(inventoryEvents)
    expect(inventoryModule.definition.capabilities).toBe(inventoryCapabilities)
    expect(inventoryModule.router, 'a module with a contract has to mount a router').toBeTypeOf('function')
  })
})

/**
 * Capabilities, which are the one thing here that cannot be seen by reading a handler.
 *
 * A missing `requiresCapability` is invisible: the procedure compiles, every other test passes, and
 * the only symptom is a workspace successfully calling a feature it switched off. So the map is
 * declared as data in the contract and checked against the router here.
 *
 * The map is empty while `core` is the only capability — `core` is `required`, so nothing sits
 * behind a switch anyone can flip. These tests are what keep that true as the map fills up.
 */
describe('capabilities are enforced where they are declared', () => {
  const gated = new Set(Object.values(inventoryCapabilityProcedures).flat())

  it('names only capabilities the module actually declares', () => {
    const declaredIds = new Set(inventoryCapabilities.map((c) => c.id))
    for (const id of Object.keys(inventoryCapabilityProcedures))
      expect({ id, declared: declaredIds.has(id) }).toEqual({ id, declared: true })
  })

  it('names only procedures the contract actually has', () => {
    for (const name of gated) expect({ name, exists: name in declared }).toEqual({ name, exists: true })
  })

  it('gates every procedure that belongs to a capability on that capability', async () => {
    // Identity again, not a count: a third middleware proves nothing about which capability — or
    // whether a capability — is being checked. `workspaceScoped` -> `requiresCapability` ->
    // `requires`, in that order, so a workspace with the whole module off is refused before
    // anything reveals which capabilities it would have had.
    for (const [capability, names] of Object.entries(inventoryCapabilityProcedures)) {
      for (const name of names) {
        const chain = await Promise.all(chainOf(name).map(reachedFor))
        const gate = chain.findIndex((r) => r.capability === `${MODULE_ID}.${capability}`)
        const permission = chain.findIndex((r) => r.permission !== undefined)
        expect(gate, `${name}: needs requiresCapability('${MODULE_ID}', '${capability}')`).toBeGreaterThan(0)
        expect(gate, `${name}: the capability gate belongs before the permission check`).toBeLessThan(
          permission,
        )
      }
    }
  })

  it('leaves `core` off the map, because a required capability is not a switch', () => {
    expect(inventoryCapabilityProcedures.core).toBeUndefined()
    expect(inventoryCapabilities.find((c) => c.id === 'core')?.required).toBe(true)
  })
})
