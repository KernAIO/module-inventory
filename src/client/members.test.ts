import { describe, expect, it } from 'vitest'
import { directory, directoryStatus, displayName, type NameWords, nameOf, resolveName } from './members.js'
import { en } from './messages.js'

/**
 * What a stored uuid reads as, and — the part that was wrong — *when* it is entitled to say so.
 *
 * `nameOf` resolved every id it could not find to "a former member". That is a claim about a
 * person, and it was made in two states where nothing was known about anybody: while the members
 * request was still in flight, and after it had failed. So an asset panel opened on a laptop that
 * had changed hands twice read
 *
 *     A former member handed it to A former member
 *     A former member took it back from A former member
 *
 * for the first moments of every load — and permanently whenever core was unreachable, which is
 * exactly when somebody is most likely to be staring at the screen trying to work out what happened.
 *
 * Neither state can be told from an empty map, which is why the fix is on the `Directory` rather
 * than at the call sites: the request's own state has to travel with the rows.
 */
const member = (userId: string, name: string | null, email: string) => ({
  userId,
  user: { id: userId, name, email },
})

const PEOPLE = [
  member('a', 'Ada Lovelace', 'ada@example.com'),
  member('b', null, 'bruno@example.com'),
  member('c', '   ', 'carla@example.com'),
]

const words: NameWords = {
  loading: '…',
  unknown: 'Someone',
  former: 'A former member',
  system: 'The system',
}

describe('displayName', () => {
  it('falls back to the email for somebody who has never signed in', () => {
    const dir = directory(PEOPLE)
    expect(displayName(dir.byId.get('b'))).toBe('bruno@example.com')
  })

  it('treats a blank name as absent, so no row has an empty person column', () => {
    const dir = directory(PEOPLE)
    expect(displayName(dir.byId.get('c'))).toBe('carla@example.com')
  })
})

describe('directoryStatus', () => {
  it('reads a query that has not answered as loading, not as an empty workspace', () => {
    expect(directoryStatus({ isSuccess: false, isError: false })).toBe('loading')
  })

  it('reads a failure as its own state rather than as an absence', () => {
    expect(directoryStatus({ isSuccess: false, isError: true })).toBe('error')
  })

  it('is ready only once the data is actually in hand', () => {
    // `isSuccess`, never `!isPending`: a query with `enabled: false` reports `isPending` for ever,
    // and the assets page disables this one until something is filtered by custodian.
    expect(directoryStatus({ isSuccess: true, isError: false })).toBe('ready')
  })
})

describe('resolveName tells the three unknowns apart', () => {
  const ready = directory(PEOPLE, 'ready')
  const loading = directory([], 'loading')
  const failed = directory([], 'error')
  const gone = '01920000-0000-7000-8000-00000000dead'

  it('names somebody the workspace has', () => {
    expect(resolveName('a', ready)).toEqual({ kind: 'person', name: 'Ada Lovelace' })
  })

  it('says nothing at all while the member list is still in flight', () => {
    // The regression. This answered `former` — "A former member handed it to A former member" —
    // for the first moments of every panel, about people who had not gone anywhere.
    expect(resolveName('a', loading)).toEqual({ kind: 'loading', name: null })
    expect(resolveName(gone, loading)).toEqual({ kind: 'loading', name: null })
  })

  it('says the lookup failed rather than that the person left', () => {
    // The same claim, made permanent: with core unreachable, every name on the screen used to
    // report that its owner had been removed from the workspace.
    expect(resolveName('a', failed)).toEqual({ kind: 'unknown', name: null })
  })

  it('says somebody has left only once the list is in hand and does not contain them', () => {
    expect(resolveName(gone, ready)).toEqual({ kind: 'former', name: null })
  })

  it('has no name for a row nothing signed, in every state', () => {
    for (const dir of [ready, loading, failed])
      expect(resolveName(null, dir)).toEqual({ kind: 'system', name: null })
  })

  it('carries a name only for somebody actually found, which is what the avatar reads', () => {
    // An `Avatar` seeded with "…" would draw the initials of an ellipsis in a coloured square.
    for (const resolved of [resolveName('a', loading), resolveName(gone, ready), resolveName(null, ready)])
      if (resolved.kind !== 'person') expect(resolved.name).toBe(null)
  })
})

describe('nameOf', () => {
  const ready = directory(PEOPLE, 'ready')

  it('gives each of the four unknowns its own word', () => {
    expect(nameOf('a', ready, words)).toBe('Ada Lovelace')
    expect(nameOf('a', directory([], 'loading'), words)).toBe('…')
    expect(nameOf('a', directory([], 'error'), words)).toBe('Someone')
    expect(nameOf('gone', ready, words)).toBe('A former member')
    expect(nameOf(null, ready, words)).toBe('The system')
  })

  it('never renders a raw uuid', () => {
    const uuid = '01920000-0000-7000-8000-00000000dead'
    for (const dir of [ready, directory([], 'loading'), directory([], 'error')])
      expect(nameOf(uuid, dir, words)).not.toContain(uuid)
  })

  /**
   * The words are translated, and a missing one would render the key — `inventory.member_loading`
   * — in the middle of a timeline entry, in every locale at once.
   */
  it('has a catalogue entry for every word it asks a screen for', () => {
    for (const key of ['member_loading', 'member_unknown', 'member_former', 'member_system'])
      expect({ key, has: `inventory.${key}` in en }).toEqual({ key, has: true })
  })
})
