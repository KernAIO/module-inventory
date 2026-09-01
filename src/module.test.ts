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
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  options: { context: unknown; procedure?: unknown; next: (options?: unknown) => Promise<unknown> },
  input: unknown,
) => Promise<unknown>

const WORKSPACE = '00000000-0000-4000-8000-000000000000'

async function reachedFor(middleware: unknown, procedure: unknown): Promise<Reached> {
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
    // kernel 0.9.1 added two gates inside workspaceScoped, after the membership check. Both must
    // fall open here: nothing bills in a test, so the API budget never refuses and entitlements
    // answer source 'none' — the shape a self-hosted instance runs with (falls open on purpose).
    apiBudget: {
      check: async () => ({ ok: true, limit: 60, retryAfterSec: 60 }),
    },
    entitlements: {
      of: async () => ({ source: 'none', active: true }),
      requireActive: async () => undefined,
    },
  }
  const principal = { kind: 'user', userId: WORKSPACE, instanceAdmin: false, memberships: [] }
  // kernel 0.9.1's workspaceScoped reads the procedure's `~orpc` (route method + middlewares) to
  // decide whether the subscription gate applies. Builder views in the implemented router do not
  // always carry a route (or the full `~orpc`); give any such view the shape of a plain non-reading
  // procedure, so the gate reads safely and falls open through entitlements `source: 'none'`.
  const proc = procedure as { '~orpc'?: { route?: unknown; middlewares?: unknown } } | undefined
  const normalized = proc?.['~orpc']
    ? proc['~orpc'].route
      ? procedure
      : { '~orpc': { ...proc['~orpc'], route: {} } }
    : { '~orpc': { route: {}, middlewares: [] } }
  await (middleware as MiddlewareFn)(
    { context: { kernel, principal }, procedure: normalized, next: async () => ({}) },
    { workspaceId: WORKSPACE },
  )
  return seen
}

const chainOf = (name: string): unknown[] => implemented[name]?.['~orpc'].middlewares ?? []

/** What every implemented procedure's middleware chain reached for, resolved once. */
async function resolveChains(): Promise<Record<string, Reached[]>> {
  const entries = await Promise.all(
    Object.keys(implemented).map(
      async (name) =>
        [name, await Promise.all(chainOf(name).map((m) => reachedFor(m, implemented[name])))] as const,
    ),
  )
  return Object.fromEntries(entries)
}

/**
 * Which of `names` the router does **not** put behind `capability`, in the right place.
 *
 * A pure function of the chains rather than an assertion inside a loop, so the check can be aimed at
 * a chain this file builds by hand — which is the only way to show that it rejects what it claims
 * to. An assertion that has never been seen to fail is a comment with a green tick beside it.
 *
 * Two ways to fail, and both matter: no capability gate at all, and a gate that sits *after* the
 * permission check. The order is the whole point of `workspaceScoped` → `requiresCapability` →
 * `requires`: a workspace with the module off must be refused before anything reveals which
 * capabilities it would have had, and a workspace with the capability off must get 404 rather than
 * the 403 a permission check would produce first.
 */
function ungated(capability: string, names: readonly string[], chains: Record<string, Reached[]>): string[] {
  return names.filter((name) => {
    const chain = chains[name] ?? []
    const gate = chain.findIndex((r) => r.capability === `${MODULE_ID}.${capability}`)
    const permission = chain.findIndex((r) => r.permission !== undefined)
    // Index 0 is `workspaceScoped`'s place, so a gate there is a gate that displaced it.
    if (gate < 1) return true
    return permission !== -1 && gate > permission
  })
}

describe('every procedure is authorised', () => {
  const declaredKeys = new Set<string>(inventoryPermissions.map((p) => p.key))

  it('puts the workspace and module gate first, on every procedure', async () => {
    for (const name of Object.keys(implemented)) {
      const [first] = chainOf(name)
      expect(
        first === undefined ? undefined : (await reachedFor(first, implemented[name])).module,
        `${name}: the first middleware has to be workspaceScoped('${MODULE_ID}') — a real membership, and the module switched on for that workspace`,
      ).toBe(MODULE_ID)
    }
  })

  it('puts a permission check the module declares after it', async () => {
    for (const name of Object.keys(implemented)) {
      const asked = (
        await Promise.all(
          chainOf(name)
            .slice(1)
            .map((m) => reachedFor(m, implemented[name])),
        )
      )
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
 * the only symptom is a workspace successfully calling a feature it switched off.
 *
 * **The expectation is derived from the contract, not opted into.** This used to check only the
 * procedures named in `inventoryCapabilityProcedures` — so the map was both the claim and the
 * evidence for it, and the regression it exists to catch walked straight past: add
 * `repairs.cancel` to the contract, forget the middleware, forget the map, and every test here is
 * green while a workspace with repairs switched off can call it. A list that has to be updated by
 * the same person who forgot the thing it is guarding is not a guard.
 *
 * So the rule is read off the module's own declarations instead: **a switchable capability owns the
 * router group named after it**, and every procedure in that group is gated on it. `repairs.*`
 * belongs to `repairs`; `attachments.*` belongs to `attachments`. Adding a procedure to either group
 * fails this file until it carries the middleware, whatever the map says. The map is still checked —
 * it is what the client reads — but now against the group rather than against itself.
 */
describe('capabilities are enforced where they are declared', () => {
  const gated = new Set(Object.values(inventoryCapabilityProcedures).flat())

  /** The capabilities a workspace can actually switch: `core` is `required` and owns nothing. */
  const switchable = inventoryCapabilities.filter((c) => !c.required).map((c) => c.id)

  /** The contract's procedures under a capability's own name — the derived expectation. */
  const groupOf = (capability: string) =>
    Object.keys(declared)
      .filter((name) => name.startsWith(`${capability}.`))
      .sort()

  it('gates every procedure in a switchable capability’s own group, named in the map or not', async () => {
    const chains = await resolveChains()
    for (const capability of switchable) {
      expect(
        groupOf(capability).length,
        `${capability}: declared as a switch with no procedures behind it — a switch that changes nothing teaches an administrator that the switchboard does not mean anything`,
      ).toBeGreaterThan(0)
      expect(
        ungated(capability, groupOf(capability), chains),
        `these need requiresCapability('${MODULE_ID}', '${capability}') between the workspace gate and the permission check`,
      ).toEqual([])
    }
  })

  it('names that whole group in the map, so the client and the router cannot drift', () => {
    // The client reads this map to decide what to hide; the router decides what to answer. A
    // procedure gated in one and not the other is a tab that is there and 404s, or hidden and works.
    for (const capability of switchable)
      expect([...(inventoryCapabilityProcedures[capability] ?? [])].sort()).toEqual(groupOf(capability))
  })

  it('rejects an ungated procedure, and one gated in the wrong place', () => {
    /**
     * The assertion aimed at chains built here, because a check nobody has watched fail is a check
     * nobody knows the shape of. Four procedures, one correct and three not, and `ungated` has to
     * name exactly the three.
     */
    const chains: Record<string, Reached[]> = {
      'repairs.list': [
        { module: MODULE_ID },
        { capability: `${MODULE_ID}.repairs` },
        { permission: 'inventory.asset.view' },
      ],
      // The regression this file exists for: somebody added a procedure and no middleware.
      'repairs.create': [{ module: MODULE_ID }, { permission: 'inventory.repair.manage' }],
      // Gated, but after the permission — so a workspace with the capability off gets 403 from the
      // permission check before the 404 that is the honest answer.
      'repairs.update': [
        { module: MODULE_ID },
        { permission: 'inventory.repair.manage' },
        { capability: `${MODULE_ID}.repairs` },
      ],
      // Gated on a different capability, which the identity check is what catches.
      'repairs.complete': [
        { module: MODULE_ID },
        { capability: `${MODULE_ID}.attachments` },
        { permission: 'inventory.repair.manage' },
      ],
    }
    expect(ungated('repairs', Object.keys(chains), chains)).toEqual([
      'repairs.create',
      'repairs.update',
      'repairs.complete',
    ])
  })

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

/**
 * The manifest's other declarations — the ones that are handlers rather than middleware.
 *
 * Every entry here is a promise to the rest of the product, and each has exactly one shape of lie
 * available to it: an object type with no resolver renders a link to nothing, a search indexer for a
 * type nobody declared indexes documents nothing can open, a notification type nothing sends is a
 * row in everybody's preferences that changes nothing, and a job with no cron never runs. All four
 * compile. `objectTypes` was removed from this module in 0.2.0 for precisely the first of them.
 */
describe('the platform surfaces the module declares', () => {
  const objectTypes = inventoryModule.definition.objectTypes ?? []

  it('backs every object type with a resolver and an indexer', () => {
    const resolved = new Set((inventoryModule.resolvers ?? []).map((r) => r.type))
    const indexed = new Set((inventoryModule.search ?? []).flatMap((s) => s.types))
    for (const { type } of objectTypes)
      expect({ type, resolved: resolved.has(type), indexed: indexed.has(type) }).toEqual({
        type,
        resolved: true,
        indexed: true,
      })
  })

  it('declares every type it resolves or indexes, so nothing points at an undeclared noun', () => {
    const declared = new Set(objectTypes.map((o) => o.type))
    for (const resolver of inventoryModule.resolvers ?? [])
      expect({ type: resolver.type, declared: declared.has(resolver.type) }).toEqual({
        type: resolver.type,
        declared: true,
      })
    for (const type of (inventoryModule.search ?? []).flatMap((s) => s.types))
      expect({ type, declared: declared.has(type) }).toEqual({ type, declared: true })
  })

  it('offers a full reindex as well as a single load', () => {
    // Without `scan`, `core.search.reindex` walks this module and finds nothing to do — silently,
    // which is the worst way for a repair mechanism to be missing.
    for (const indexer of inventoryModule.search ?? [])
      expect({ types: indexer.types, scan: typeof indexer.scan }).toEqual({
        types: indexer.types,
        scan: 'function',
      })
  })

  it('gives every scheduled job a name of its own and a schedule', () => {
    const jobs = inventoryModule.jobs ?? []
    expect(jobs.length, 'a module with sweeps declares them').toBeGreaterThan(0)
    expect(new Set(jobs.map((j) => j.name)).size, 'two jobs sharing a name share a queue').toBe(jobs.length)
    // Every job this module has is a sweep; one without a cron would be a queue nothing enqueues.
    for (const job of jobs)
      expect({ job: job.name, cron: typeof job.cron }).toEqual({ job: job.name, cron: 'string' })
  })

  it('names every notification type under its own module id', () => {
    for (const type of inventoryModule.definition.notificationTypes ?? [])
      expect(type.type.startsWith(`${MODULE_ID}.`), type.type).toBe(true)
  })

  /**
   * A notification type nothing sends is the same lie as a permission nothing checks — and unlike a
   * permission there is no middleware to inspect, so this reads the server for the string.
   *
   * Crude on purpose, and honest about it: it proves the *literal* appears in a file that sends
   * notifications, not that the branch is reachable. A type whose key was built by concatenation
   * would slip past it. Every one of this module's four is a literal at its call site, and keeping
   * them that way is the point — a notification type assembled at runtime is one nobody can grep
   * for either.
   */
  it('has a sender in the server for every notification type it declares', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const sources = readdirSync(join(here, 'server'), { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => readFileSync(join(here, 'server', f), 'utf8'))
      .join('\n')
    for (const { type } of inventoryModule.definition.notificationTypes ?? [])
      expect({ type, sent: sources.includes(`'${type}'`) }).toEqual({ type, sent: true })
  })

  /**
   * The client manifest's `name` is read on screen, so it has to be a getter over `t`.
   *
   * The dashboard's widget picker heads this module's group with `mod.name` directly, and the shell's
   * settings rail falls back to it for a module whose navigation it cannot read — so an English
   * literal there is a Latin word sitting in an otherwise Persian panel. `name` is typed as a plain
   * `string` on `ClientModule`, which is exactly why nothing else catches this: a literal and a
   * getter are the same type.
   *
   * Read as text rather than imported, and honest about being crude. `src/client/module.ts` reaches
   * `@kernhq/ui`, which drags a Svelte compiler into whatever imports it, and this package's vitest
   * runs plain Node — the same reason `errors.ts` and `messages.ts` are kept importable and the
   * components are not. It proves the shape, not the rendering.
   */
  it('gives the client manifest a translated name rather than an English literal', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(here, 'client', 'module.ts'), 'utf8')
    expect(source, 'a getter, so the language is the one on screen at read time').toMatch(
      /get name\(\)\s*\{\s*return t\('nav'\)/,
    )
    expect(source, 'and no literal left beside it').not.toMatch(/^\s*name: '/m)
  })
})
