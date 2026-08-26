/**
 * What this module offers, as data.
 *
 * A barrel and nothing else: every symbol is defined in the file beside it. Imported by **both**
 * halves — the server implements the contract, the client calls it — so nothing reachable from here
 * may touch Node. A procedure that exists here and not in the router is a lie that compiles, and
 * `module.test.ts` checks exactly that.
 */

export * from './capabilities.js'
export * from './events.js'
export * from './models.js'
export * from './permissions.js'
export * from './router.js'
export * from './settings.js'
