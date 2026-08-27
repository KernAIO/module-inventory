/**
 * Which constraint Postgres refused a write with, dug out of what drizzle hands back.
 *
 * A database constraint is only half a feature. `inventory_custody_no_overlap` makes two open
 * custody periods for one asset impossible — but two people pressing *Hand over* on the same laptop
 * at the same instant means the loser is shown drizzle's own text, "Failed query: insert into
 * mod_inventory.custody_periods …", which tells a person nothing they can act on and looks like the
 * product broke rather than like somebody else got there first.
 *
 * So the service catches, asks these two questions, and throws a `KernError.conflict` with a
 * sentence. Reaching through `cause` rather than reading the top frame is the load-bearing part:
 * drizzle wraps the driver's error, and the driver's error is the only object carrying `code` and
 * `constraint`. `src/server/inventory.int.test.ts` walks the same chain for the same reason.
 */
const MAX_DEPTH = 5

interface DriverError {
  code?: unknown
  constraint?: unknown
  cause?: unknown
}

function walk(err: unknown, read: (e: DriverError) => string | undefined): string | undefined {
  let cursor: unknown = err
  for (let depth = 0; depth < MAX_DEPTH && cursor; depth++) {
    const found = read(cursor as DriverError)
    if (found) return found
    cursor = (cursor as DriverError).cause
  }
  return undefined
}

/** The constraint's name, if a named one refused the write. */
export const constraintOf = (err: unknown): string | undefined =>
  walk(err, (e) => (typeof e.constraint === 'string' ? e.constraint : undefined))

/** The SQLSTATE, if one reached us. `23P01` is an exclusion violation, `23505` a unique one. */
export const sqlStateOf = (err: unknown): string | undefined =>
  walk(err, (e) => (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : undefined))

/** Did this write lose to `name`, whichever way Postgres reported it? */
export const violated = (err: unknown, name: string): boolean => constraintOf(err) === name
