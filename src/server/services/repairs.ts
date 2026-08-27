import { KernError, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, desc, eq, isNotNull, isNull, lt } from 'drizzle-orm'
import type {
  RepairInput,
  RepairListItem,
  Repair as RepairModel,
  RepairPatchInput,
} from '../../contract/models.js'
import { assets, repairs } from '../schema.js'
import { decodeMark, encodeMark } from './cursor.js'
import { violated } from './db-errors.js'
import type { HistoryInput, NotifyService } from './notify.js'
import { awayForRepair, deriveStatus, lockAsset } from './status.js'

type Row = typeof repairs.$inferSelect
type AssetRow = typeof assets.$inferSelect

/** The partial unique index `0003_repairs.sql` added. Two open repairs for one asset are it. */
const ONE_OPEN = 'inventory_repairs_one_open_uq'

/** The CHECK `0005_repair_dates.sql` added. A repair that came back before it was sent is it. */
const IN_ORDER = 'inventory_repairs_returned_after_sent'

/**
 * The one ordering a repair list has, named rather than left as a literal.
 *
 * The cursor codec binds a bookmark to the sort it was issued under and refuses it under any other,
 * so this list needs a name for its sort even while there is only one — and the day a second one
 * exists, every cursor already in a browser tab is refused rather than misread.
 */
const REPAIR_SORT = 'recent'

/** The wire shape: drizzle gives Date objects for timestamps, the contract promises ISO strings. */
export function toRepair(row: Row): RepairModel {
  return {
    id: row.id,
    workspaceId: row.workspaceId as RepairModel['workspaceId'],
    assetId: row.assetId,
    summary: row.summary,
    detail: row.detail,
    vendor: row.vendor,
    costMinor: row.costMinor,
    currency: row.currency,
    sentOn: row.sentOn,
    returnedOn: row.returnedOn ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * What one repair mutation wrote, and what may only leave the module once it has committed.
 *
 * The asset comes back beside the repair because sending an item away moves `assets.status`, and a
 * caller that fetched the asset again afterwards would be reading a row somebody else may have
 * changed in between — the panel would then show a repair that has already been completed.
 */
export interface RepairWritten {
  repair: Row
  asset: AssetRow
  /** `null` when nothing happened worth recording, which is what an edit that changed nothing is. */
  activity: HistoryInput | null
}

export interface RepairListInput {
  limit: number
  cursor?: string
  assetId?: string
  /** `true` for still away, `false` for finished, absent for both. */
  open?: boolean
}

/**
 * What went away to be fixed, and what came back.
 *
 * Three things happen in one transaction on every change here, and the point of the class is that
 * they cannot come apart: the repair row moves, `assets.status` is brought into step with it through
 * `deriveStatus`, and an `asset_history` entry records it.
 *
 * **The database is the arbiter of "already away", not this file.** There is deliberately no
 * `select … for update` on the asset *before* the repair row is written:
 * `inventory_repairs_one_open_uq` — a unique index on `(asset_id) where returned_on is null` — is
 * what makes two open repairs impossible, so two people pressing *Send for repair* on the same
 * laptop in the same instant both read "it is here", both insert, and Postgres refuses exactly one
 * of them. Checking first and inserting after is the race, not the fix. What this file owes the
 * loser is a sentence they can act on rather than drizzle's "Failed query: insert into
 * mod_inventory.repairs …".
 *
 * **`restamp` does lock it, afterwards, and that is a different job.** `assets.status` is derived
 * from this module's repair rows *and* from custody, which another service writes, so the winner
 * still has to compute an answer nobody can overwrite from a stale snapshot. See `lockAsset` in
 * `status.ts`: the index decides the contest, the lock orders the bookkeeping that follows it.
 *
 * **Repairs do not touch custody.** An item at the repairer is still somebody's responsibility; see
 * `status.ts`, where that rule is argued in full.
 */
export class RepairService {
  constructor(private readonly notify: NotifyService) {}

  /**
   * Today, as this module means it: the UTC date.
   *
   * Not the browser's date, and not a workspace time zone — a repair is dated to the day, and the
   * two hours a workspace in Istanbul is ahead of UTC would put an evening repair on tomorrow for
   * one reader and today for another. One clock, the server's, the same reasoning that keeps asset
   * tags server-side. A workspace that needs the exact day sends `sentOn` itself.
   */
  private static today(): string {
    return new Date().toISOString().slice(0, 10)
  }

  /** The one error a lost race produces, in every place a race can be lost. */
  private static alreadyAway(): KernError {
    return KernError.conflict(
      'This item is already away for repair. Log that one as returned first.',
      'inventory.repair.already_open',
    )
  }

  /**
   * A repair cannot come back before it was sent — checked on every path that writes either date.
   *
   * `complete` has always refused a return date before the send date, and `update` did not: it took
   * `sentOn` from the patch and wrote it whatever the row already said, so correcting the send date
   * of a *finished* repair could move it past the day the item came back. What that stores is a
   * repair that ended before it started — every "how long was it away" answer negative, the overdue
   * sweep measuring from a date in the future, and nothing anywhere to say which of the two dates is
   * the wrong one.
   *
   * Both are `date` columns, so they read back as `YYYY-MM-DD` and compare correctly as text.
   *
   * The database holds the same rule (`inventory_repairs_returned_after_sent`), because two
   * transactions can each pass this check and still write a pair that fails it: one moving `sent_on`
   * while the other logs the item back. This runs first so the ordinary case gets a sentence rather
   * than a constraint violation; `outOfOrder` is what the loser of that race gets.
   */
  private static requireInOrder(sentOn: string, returnedOn: string | null): void {
    if (returnedOn !== null && returnedOn < sentOn) throw RepairService.outOfOrder()
  }

  private static outOfOrder(): KernError {
    return KernError.conflict(
      'A repair cannot come back before it was sent.',
      'inventory.repair.returned_before_sent',
    )
  }

  /**
   * One day past today, which is the whole tolerance a date typed by a person needs.
   *
   * `today()` is UTC — one clock, the server's, for the reason it documents — and a workspace in
   * Auckland is up to fourteen hours ahead of it, so *their* today is UTC's tomorrow for a large
   * part of their working day. Refusing at exactly UTC-today would refuse the ordinary case in half
   * the world's offices. A day is enough for every real time zone and is nowhere near enough to be
   * the defect below.
   */
  private static readonly FUTURE_GRACE_DAYS = 1

  /**
   * A repair cannot be sent from the future — checked on every path that writes `sent_on`.
   *
   * `sentOn` is a date a person types, and nothing bounded it. A repair dated 2030 is one the
   * overdue sweep can never find: it looks for `sent_on <= today - repairOverdueDays`, so a send
   * date years ahead is permanently outside the window and the chase never fires. Not for a while —
   * **ever**, for the life of that row, and silently, because a sweep that finds nothing looks
   * exactly like a sweep with nothing to do. It also makes every "how long has it been away" answer
   * negative and puts the item at the top of a list ordered by when it left.
   *
   * A typo is the likely cause and a deliberate one is the dangerous case: this is the one field
   * that decides whether anybody is ever reminded that a vendor still has the company's laptop.
   *
   * Bounded on the *server*, not in the contract, and both halves of that are deliberate. The
   * contract is shared with the browser, so a `refine` there would compare against the reader's own
   * clock — and a client whose date is a day ahead would refuse a date the server accepts, or the
   * other way round. And it is a sentence rather than a bare `invalid_string`, because "a repair
   * cannot be sent in the future" is something a person can act on.
   *
   * **A `BAD_REQUEST` with no `reason`, like `checkPhoto`'s refusal and the category check in
   * `AssetService`.** The date is malformed rather than contested — nothing raced, no state
   * changed underneath anybody, the value simply cannot be true — and `CONFLICT` is this module's
   * word for losing a race. The cost is that the sentence reaches a Persian or Turkish reader in
   * English: a translated refusal needs a stable `reason` **and** its five bundles in
   * `src/client/errors.ts`, and the two have to arrive together or `errors.test.ts` fails from
   * whichever side is ahead.
   */
  private static requireNotFuture(sentOn: string): void {
    const limit = new Date(`${RepairService.today()}T00:00:00Z`)
    limit.setUTCDate(limit.getUTCDate() + RepairService.FUTURE_GRACE_DAYS)
    if (sentOn > limit.toISOString().slice(0, 10))
      throw KernError.badRequest('A repair cannot be sent in the future.')
  }

  private async asset(tx: Tx, workspaceId: string, assetId: string): Promise<AssetRow> {
    const [row] = await tx
      .select()
      .from(assets)
      .where(and(eq(assets.workspaceId, workspaceId), eq(assets.id, assetId)))
    if (!row) throw KernError.notFound('Asset')
    return row
  }

  async get(tx: Tx, workspaceId: string, repairId: string): Promise<Row> {
    const [row] = await tx
      .select()
      .from(repairs)
      .where(and(eq(repairs.workspaceId, workspaceId), eq(repairs.id, repairId)))
    if (!row) throw KernError.notFound('Repair')
    return row
  }

  /**
   * One asset's repairs, or the whole workspace's — one query with one filter, because they are one
   * question asked at two scopes and a second query answering it would be a second one to keep in
   * step.
   *
   * **Paged by id, newest logged first.** An id is uuidv7, so it already carries the clock, and it
   * is unique where `sent_on` is a date two repairs logged on the same day share — a page boundary
   * between two rows that share a sort key repeats one and drops the other. The same reasoning
   * `assets.list` gives for `sort: 'recent'` and `assets.history` gives for ordering on the row id.
   */
  async list(
    tx: Tx,
    workspaceId: string,
    input: RepairListInput,
  ): Promise<{ items: RepairListItem[]; nextCursor: string | null }> {
    const filters = [eq(repairs.workspaceId, workspaceId)]
    if (input.assetId) filters.push(eq(repairs.assetId, input.assetId))
    if (input.open === true) filters.push(isNull(repairs.returnedOn))
    if (input.open === false) filters.push(isNotNull(repairs.returnedOn))
    if (input.cursor) filters.push(lt(repairs.id, decodeMark(input.cursor, REPAIR_SORT).i))

    /**
     * Joined to the asset for its tag and name — inside one schema, which is the join a module is
     * allowed to make. A workspace-wide list of what is away is unreadable without them, and
     * copying them into `repairs` would be a label that goes stale the first time somebody renames
     * an asset.
     */
    const rows = await tx
      .select({ repair: repairs, code: assets.code, name: assets.name })
      .from(repairs)
      .innerJoin(assets, and(eq(assets.id, repairs.assetId), eq(assets.workspaceId, repairs.workspaceId)))
      .where(and(...filters))
      .orderBy(desc(repairs.id))
      .limit(input.limit + 1)

    const window = rows.slice(0, input.limit)
    const last = window.at(-1)
    const nextCursor =
      rows.length > input.limit && last ? encodeMark({ i: last.repair.id, s: REPAIR_SORT }) : null
    const items = window.map((row) => ({
      ...toRepair(row.repair),
      assetCode: row.code,
      assetName: row.name,
    }))
    return { items, nextCursor }
  }

  /**
   * The currency to store, given what the caller said and what is already there.
   *
   * A cost with no unit is not a cost, so an amount recorded with no currency inherits the asset's.
   * **Inheritance fires in exactly one case** — an amount is being recorded and the repair has no
   * currency at all — and getting that wrong is silent in both directions:
   *
   * - inheriting whenever a cost *exists* rather than whenever one *arrives* means an unrelated
   *   edit (correcting a vendor) silently gives the asset's currency back to a repair whose
   *   currency somebody deliberately cleared;
   * - inheriting over a currency the repair already has means recording an amount in dollars on an
   *   asset priced in euros quietly relabels it as euros.
   *
   * `undefined` means "not mentioned" and an explicit `null` means "no currency", which a workspace
   * that records amounts and not currencies genuinely means. Collapsing the two is the mistake
   * `assets.update` documents one file over.
   */
  private static currencyFor(opts: {
    /** What the request said, if it said anything. */
    patch: string | null | undefined
    /** The amount the request is recording, if it is recording one. */
    cost: number | null | undefined
    /** The currency the repair carries now. */
    previous: string | null
    asset: AssetRow
  }): string | null {
    if (opts.patch !== undefined) return opts.patch ?? null
    if (opts.previous !== null) return opts.previous
    return opts.cost === null || opts.cost === undefined ? null : (opts.asset.currency ?? null)
  }

  /** Send it away. Refuses when it is already at a repairer — that is what `complete` is for. */
  async create(
    tx: Tx,
    workspaceId: string,
    actorId: string | null,
    assetId: string,
    input: RepairInput,
  ): Promise<RepairWritten> {
    const asset = await this.asset(tx, workspaceId, assetId)
    // An archived asset is one the workspace has said it no longer tracks. Paying to fix something
    // that is not in the register is a mistake worth naming rather than recording.
    if (asset.archivedAt)
      throw KernError.conflict(
        'This item is archived. Restore it before sending it for repair.',
        'inventory.repair.archived',
      )

    const sentOn = input.sentOn ?? RepairService.today()
    // Vacuous today, and deliberately here rather than reasoned about: `RepairInput` carries no
    // `returnedOn`, so a new repair is always still away. The day it carries one, this is already
    // the check, instead of being the one write path somebody forgot.
    RepairService.requireInOrder(sentOn, null)
    RepairService.requireNotFuture(sentOn)

    let row: Row
    try {
      const inserted = await tx
        .insert(repairs)
        .values({
          id: uuidv7(),
          workspaceId,
          assetId,
          summary: input.summary,
          detail: input.detail ?? null,
          vendor: input.vendor ?? null,
          costMinor: input.costMinor ?? null,
          currency: RepairService.currencyFor({
            patch: input.currency,
            cost: input.costMinor,
            previous: null,
            asset,
          }),
          sentOn,
          createdBy: actorId,
        })
        .returning()
      row = inserted[0]!
    } catch (err) {
      // The index bit: another transaction opened a repair for this asset between our read and our
      // insert. Anything else is a real fault and must not be disguised as a lost race.
      if (violated(err, ONE_OPEN)) throw RepairService.alreadyAway()
      throw err
    }

    const updated = await this.restamp(tx, workspaceId, assetId)
    const activity: HistoryInput = {
      workspaceId,
      assetId,
      actorId,
      action: 'repair_logged',
      data: { repairId: row.id, summary: row.summary, ...(row.vendor ? { vendor: row.vendor } : {}) },
    }
    await this.notify.history(tx, activity)
    return { repair: row, asset: updated, activity }
  }

  /**
   * Correct what was recorded — a vendor, or a cost that arrived with the invoice a week later.
   *
   * **`returnedOn` is deliberately not patchable.** That one column decides whether the asset reads
   * as `under_repair`, so exactly one procedure moves it and the derived status has one door rather
   * than two. Editing a finished repair is allowed all the same: the invoice usually arrives after
   * the item does.
   *
   * **No `actorId`, because nothing here records one.** This writes no timeline entry — see the
   * bottom of the method — and a parameter kept for symmetry with `create` and `complete` would be
   * a parameter every caller has to supply and nothing reads.
   */
  async update(
    tx: Tx,
    workspaceId: string,
    repairId: string,
    patch: RepairPatchInput,
  ): Promise<RepairWritten> {
    const previous = await this.get(tx, workspaceId, repairId)
    const asset = await this.asset(tx, workspaceId, previous.assetId)

    // `undefined` means "not mentioned"; `null` means "clear it". Collapsing the two is how an edit
    // of one field quietly wipes the others. `cost` is the patch's own value and not the merged
    // one, so correcting a vendor cannot give the asset's currency back to a repair whose currency
    // somebody deliberately cleared.
    const sentOn = patch.sentOn ?? previous.sentOn
    // `returnedOn` is not patchable, so the row's own value is the one this has to stay behind. An
    // edit that moves the send date past the day the item came back is refused rather than stored.
    RepairService.requireInOrder(sentOn, previous.returnedOn)
    // And the same bound `create` applies, because this is the other door onto the same column —
    // and the more dangerous one: moving `sent_on` forward also clears `overdue_notified_at`, so a
    // correction into the future re-arms a chase that can then never fire.
    RepairService.requireNotFuture(sentOn)
    const values = {
      summary: patch.summary ?? previous.summary,
      detail: patch.detail !== undefined ? (patch.detail ?? null) : previous.detail,
      vendor: patch.vendor !== undefined ? (patch.vendor ?? null) : previous.vendor,
      costMinor: patch.costMinor !== undefined ? (patch.costMinor ?? null) : previous.costMinor,
      currency: RepairService.currencyFor({
        patch: patch.currency,
        cost: patch.costMinor,
        previous: previous.currency,
        asset,
      }),
      sentOn,
      /**
       * Correcting the send date re-arms the overdue notice.
       *
       * `overdue_notified_at` marks that somebody has already been asked to chase this one, and the
       * threshold is measured from `sent_on` — so a repair re-dated a month earlier is overdue for
       * the first time and nobody would ever hear about it if the marker survived. Only when the
       * date actually moved: correcting a vendor must not send the same chase again.
       */
      overdueNotifiedAt: sentOn === previous.sentOn ? previous.overdueNotifiedAt : null,
      updatedAt: new Date(),
    }

    let row: Row | undefined
    try {
      const written = await tx
        .update(repairs)
        .set(values)
        .where(and(eq(repairs.workspaceId, workspaceId), eq(repairs.id, repairId)))
        .returning()
      row = written[0]
    } catch (err) {
      // The CHECK bit: another transaction logged the item back between the check above and this
      // statement, so the pair being written is out of order after all. A sentence, not a driver
      // dump — the same debt every other constraint in this module is paid.
      if (violated(err, IN_ORDER)) throw RepairService.outOfOrder()
      throw err
    }

    /**
     * **No timeline entry, and that is a decision.**
     *
     * The asset's timeline records what happened *to the asset*: it went away, and it came back.
     * Correcting a vendor or filling in an invoice a week later did not happen to the asset, and a
     * timeline that reported every such edit would bury the two entries that matter under the
     * paperwork around them. The repair row's own `updated_at` is where "this was edited" lives,
     * and the row is on screen beside it.
     */
    return { repair: row!, asset, activity: null }
  }

  /**
   * It came back.
   *
   * `and returned_on is null` in the predicate is the optimistic guard, exactly as
   * `CustodyService.close` uses: under READ COMMITTED a concurrent complete blocks this statement,
   * and when it resumes the row no longer matches, so zero rows come back rather than a second
   * completion silently overwriting the first one's date.
   */
  async complete(
    tx: Tx,
    workspaceId: string,
    actorId: string | null,
    repairId: string,
    input: { returnedOn?: string; costMinor?: number | null; currency?: string | null },
  ): Promise<RepairWritten> {
    const previous = await this.get(tx, workspaceId, repairId)
    if (previous.returnedOn)
      throw KernError.conflict(
        'This repair is already logged as finished.',
        'inventory.repair.already_complete',
      )
    const asset = await this.asset(tx, workspaceId, previous.assetId)

    const returnedOn = input.returnedOn ?? RepairService.today()
    // A date is a fact somebody typed, and a person deserves a sentence about it rather than a
    // constraint violation — the database refuses this pair too, and this is what stops it having
    // to.
    RepairService.requireInOrder(previous.sentOn, returnedOn)

    let row: Row | undefined
    try {
      const written = await tx
        .update(repairs)
        .set({
          returnedOn,
          costMinor: input.costMinor !== undefined ? (input.costMinor ?? null) : previous.costMinor,
          // The invoice usually arrives with the item, so this is where a cost is most often first
          // recorded — and therefore where the currency is most often inherited.
          currency: RepairService.currencyFor({
            patch: input.currency,
            cost: input.costMinor,
            previous: previous.currency,
            asset,
          }),
          updatedAt: new Date(),
        })
        .where(
          and(eq(repairs.workspaceId, workspaceId), eq(repairs.id, repairId), isNull(repairs.returnedOn)),
        )
        .returning()
      row = written[0]
    } catch (err) {
      // Another transaction moved `sent_on` past this return date between the check above and this
      // statement. See `update`, which has the same guard for the same race seen from the other end.
      if (violated(err, IN_ORDER)) throw RepairService.outOfOrder()
      throw err
    }
    if (!row)
      throw KernError.conflict(
        'Somebody logged this repair as finished a moment before you did. Reload to see where it is now.',
        'inventory.repair.already_complete',
      )

    const updated = await this.restamp(tx, workspaceId, previous.assetId)
    const activity: HistoryInput = {
      workspaceId,
      assetId: previous.assetId,
      actorId,
      action: 'repair_completed',
      data: {
        repairId: row.id,
        summary: row.summary,
        ...(row.costMinor !== null ? { costMinor: row.costMinor, currency: row.currency } : {}),
      },
    }
    await this.notify.history(tx, activity)
    return { repair: row, asset: updated, activity }
  }

  /**
   * Bring `assets.status` back into step with the facts, inside the same transaction.
   *
   * Both facts are **read** rather than assumed — the open repair as it now stands, and the
   * custodian as the asset row carries it — and `deriveStatus` decides. Assuming `under_repair`
   * after an insert and `in_stock` after a completion is the version of this that silently released
   * whoever was still holding the item.
   *
   * **The asset is locked and re-read here, rather than passed in.** It used to take the row the
   * caller had already fetched, which is a snapshot from before the repair was written and before
   * anything else that touched the asset in between: a handover committing in that window was
   * invisible, so this derived a status from a custodian that had stopped being current and wrote it
   * over the handover's answer. Taking the row under the lock is what makes "read both facts, then
   * derive" true rather than merely intended. `lockAsset` argues it in full.
   */
  private async restamp(tx: Tx, workspaceId: string, assetId: string): Promise<AssetRow> {
    const asset = await lockAsset(tx, workspaceId, assetId)
    // `true` rather than a parameter: every caller of this file is behind `requiresCapability
    // ('repairs')`, so a workspace reaching here is a workspace that records repairs by
    // construction. The two paths that are *not* behind it — custody and archive — take the switch
    // as an argument, and `deriveStatus` says why.
    const away = await awayForRepair(tx, workspaceId, assetId, true)
    /**
     * An archived item cannot be away for repair, and this is the other half of the refusal that
     * says so.
     *
     * `assets.archive` reads "nothing open against it" under this same lock, so an archive racing a
     * *new* repair is ordered against it — and whichever arrives second has to lose, or the register
     * ends up holding exactly the state the refusal claims is impossible. Only while the repair is
     * open: logging one back on a row somebody archived anyway has to stay possible, or the item is
     * trapped away for ever.
     */
    if (away && asset.archivedAt)
      throw KernError.conflict(
        'This item is archived. Restore it before sending it for repair.',
        'inventory.repair.archived',
      )
    const status = deriveStatus({ custodianUserId: asset.custodianUserId, awayForRepair: away })
    if (status === asset.status) return asset
    const [row] = await tx
      .update(assets)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(assets.workspaceId, workspaceId), eq(assets.id, assetId)))
      .returning()
    if (!row) throw KernError.notFound('Asset')
    return row
  }
}
