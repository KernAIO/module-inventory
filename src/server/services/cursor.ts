import { KernError } from '@kernhq/kernel'

/**
 * The one page boundary this module issues, for every list it pages.
 *
 * **The bookmarked row's id, and the sort it was issued under.** Nothing else — in particular not
 * the sort key itself, which is what it used to carry. That earlier shape (`{k: <sort key>, i:
 * <id>}`) was wrong three separate ways, each of them reachable by anyone who could type into the
 * address bar:
 *
 *   - **It could not be trusted.** `decode` checked only that `i` was a *string*, and `i` is
 *     interpolated into `(col, id) < ($1, $2::uuid)`. `{"k":"x","i":"not-a-uuid"}` therefore
 *     reached Postgres as a 22P02 nobody caught — an unhandled 500 and an error-level log line per
 *     request, at the 600-a-minute the rate limiter allows.
 *   - **It was not bound to its sort.** A cursor issued under `sort=recent` replayed under
 *     `sort=code` compared a uuid against a code, so page two came back equal to page one and
 *     "Load more" never ended.
 *   - **It was unbounded.** `sort=name` on a 200-character Persian name encoded to 602 characters,
 *     and `Cursor` in `@kernhq/contracts` is `max(512)` — so a long enough name broke "Load more"
 *     with a validation error, in exactly the locales least likely to be tested.
 *
 * Carrying the id alone and reading the sort key back from that row in SQL answers all three: the
 * cursor is a fixed ~60 characters whatever the name, a value that is not a uuid is refused before
 * it is anywhere near the database, and a cursor whose sort disagrees with the request is refused
 * rather than quietly misread. Base64 so nothing in the product is tempted to read it — it is a
 * bookmark, not an offset, and its shape is this file's business.
 *
 * It lives here rather than in `assets.ts` because the repair list pages too, and a second bookmark
 * format would be a second set of those three bugs. `src/client/mock.ts` mirrors this byte for
 * byte; read them as one pair and change them as one pair.
 *
 * The asset timeline is the one list that does **not** use this one: it is ordered by a sequence
 * rather than by a row id, so its bookmark is `SeqBookmark` below.
 */
export interface Bookmark<S extends string> {
  i: string
  s: S
}

export const encodeMark = <S extends string>(mark: Bookmark<S>): string =>
  Buffer.from(JSON.stringify(mark), 'utf8').toString('base64url')

/** Cheap and total, and it runs before the value can reach a `::uuid` cast. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function decodeMark<S extends string>(cursor: string, sort: S): Bookmark<S> {
  const refuse = () => KernError.badRequest('That page marker is not one this list issued')
  let parsed: Partial<Bookmark<S>> | null
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<Bookmark<S>> | null
  } catch {
    throw refuse()
  }
  if (typeof parsed?.i !== 'string' || !UUID.test(parsed.i)) throw refuse()
  // One comparison covers both a sort this list never issues and a sort it issued under a
  // *different* request. Either way the bookmark cannot be read against the ordering asked for,
  // and pretending otherwise is what made "Load more" loop for ever.
  if (parsed.s !== sort) throw refuse()
  return { i: parsed.i, s: sort }
}

/**
 * The other page boundary: a row's **sequence number**, and the sort it was issued under.
 *
 * The asset timeline is ordered by `asset_history.seq` rather than by the row id, because a uuidv7
 * is only ordered to the millisecond and two entries written inside one — an attach and a detach, a
 * create and its first entry — sort by ten random bytes. `schema.ts` argues that at the column. A
 * bookmark into that ordering has to name the sequence value, so it is a number rather than a uuid
 * and needs its own codec: handing `decodeMark` a number would have it refused as "not a uuid", and
 * relaxing `decodeMark` to accept either is how one of the two shapes ends up unvalidated.
 *
 * It keeps all three properties the uuid bookmark has, and for the same reasons:
 *
 *   - **bounded** — a base64url of `{"n":<integer>,"s":"recent"}` is around forty characters
 *     whatever the row, well inside `Cursor`'s `max(512)` in `@kernhq/contracts`;
 *   - **checked before it reaches SQL** — anything that is not a safe positive integer is refused
 *     here rather than interpolated into a `bigint` comparison for Postgres to reject as a 22P02;
 *   - **bound to its sort** — a bookmark issued under one ordering is meaningless under another,
 *     and reading it anyway is what made "Load more" loop for ever.
 *
 * `Number.isSafeInteger` is the upper bound as well as the type check: the column is a `bigint` and
 * the sequence would have to hand out nine quadrillion history rows to reach it, but a cursor
 * arrives from outside and `JSON.parse` will happily produce `1e400`.
 */
export interface SeqBookmark<S extends string> {
  n: number
  s: S
}

export const encodeSeqMark = <S extends string>(mark: SeqBookmark<S>): string =>
  Buffer.from(JSON.stringify(mark), 'utf8').toString('base64url')

export function decodeSeqMark<S extends string>(cursor: string, sort: S): SeqBookmark<S> {
  const refuse = () => KernError.badRequest('That page marker is not one this list issued')
  let parsed: Partial<SeqBookmark<S>> | null
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<SeqBookmark<S>> | null
  } catch {
    throw refuse()
  }
  if (typeof parsed?.n !== 'number' || !Number.isSafeInteger(parsed.n) || parsed.n < 1) throw refuse()
  if (parsed.s !== sort) throw refuse()
  return { n: parsed.n, s: sort }
}
