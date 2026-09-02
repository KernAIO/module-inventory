import { baseContract, PageInput, page } from '@kernhq/contracts'
import { z } from 'zod'
import {
  Asset,
  AssetCreateInput,
  AssetHistoryEntry,
  AssetPatchInput,
  AssetSort,
  AssetStatus,
  Attachment,
  Category,
  CategoryInput,
  CustodyPeriod,
  CustodyResult,
  DispositionInput,
  FieldCreateInput,
  FieldDef,
  FieldPatchInput,
  InventoryStats,
  MAX_LIVE_CATEGORIES,
  MAX_LIVE_FIELDS,
  RepairInput,
  RepairListItem,
  RepairPatchInput,
  RepairResult,
  ws,
} from './models.js'

const t = ['inventory'] as const

/** A handover note is optional everywhere and shaped the same everywhere. */
const custodyNote = z.string().max(500).nullish()

export const inventoryContract = {
  assets: {
    list: baseContract
      .route({ method: 'GET', path: '/assets', tags: t })
      .input(
        ws.extend({
          ...PageInput.shape,
          q: z.string().max(200).optional(),
          categoryId: z.uuid().optional(),
          status: AssetStatus.optional(),
          custodianUserId: z.uuid().optional(),
          /**
           * Archived rows are excluded unless asked for. The page used to filter them in the
           * browser, which is wrong the moment there is more than one page of them: the first
           * twenty rows come back, half are dropped, and the list looks short rather than paged.
           */
          archived: z.boolean().default(false),
          sort: AssetSort.default('recent'),
        }),
      )
      .output(page(Asset)),
    get: baseContract
      .route({ method: 'GET', path: '/assets/{assetId}', tags: t })
      .input(ws.extend({ assetId: z.uuid() }))
      .output(Asset),
    create: baseContract
      .route({ method: 'POST', path: '/assets', tags: t })
      .input(ws.extend(AssetCreateInput.shape))
      .output(Asset),
    update: baseContract
      .route({ method: 'PATCH', path: '/assets/{assetId}', tags: t })
      .input(ws.extend({ assetId: z.uuid(), ...AssetPatchInput.shape }))
      .output(Asset),
    archive: baseContract
      .route({ method: 'POST', path: '/assets/{assetId}/archive', tags: t })
      .input(ws.extend({ assetId: z.uuid(), archived: z.boolean().default(true) }))
      .output(Asset),
    /**
     * The asset's own timeline, newest first.
     *
     * Paged with the same keyset discipline `assets.list` uses and the same cursor codec, because a
     * second bookmark format is a second set of the three bugs the first one had. The bookmark is a
     * row id; the ordering is by id, which for a uuidv7 is the clock and, unlike `created_at`, is
     * unique — two entries written in one transaction (a create and its first custody row) share a
     * timestamp and a page boundary between them would repeat or drop one.
     *
     * Reads on `inventory.asset.view`. See `permissions.ts` for why custody is not gated separately.
     */
    history: baseContract
      .route({ method: 'GET', path: '/assets/{assetId}/history', tags: t })
      .input(ws.extend({ assetId: z.uuid(), ...PageInput.shape }))
      .output(page(AssetHistoryEntry)),

    /**
     * The two things somebody says about an item that nothing else records, and the one way back.
     *
     * Three verbs rather than a `setStatus`, for the reason custody has four: "we lost it" and
     * "we are done with it" are different facts with different refusals — an item somebody is
     * holding can be lost but cannot be retired, because retiring it would quietly release whoever
     * is answerable for it. One procedure taking a status would answer both by doing whatever the
     * row happened to allow.
     *
     * All three take `inventory.asset.manage`: they are statements about the record, and the
     * money-shaped consequences (a write-off) are a workspace's own to gate with a custom role.
     */
    /** Nobody knows where it is. Allowed while somebody holds it — they are still answerable. */
    markLost: baseContract
      .route({ method: 'POST', path: '/assets/{assetId}/lost', tags: t })
      .input(ws.extend({ assetId: z.uuid(), ...DispositionInput.shape }))
      .output(Asset),
    /**
     * The company is done with it: sold, scrapped, written off. Refuses an item somebody is holding
     * (take it back first) and one that is away for repair (log it back first), for the reasons
     * `archive` refuses the same two — nothing may quietly settle who is answerable or where the
     * thing is.
     */
    retire: baseContract
      .route({ method: 'POST', path: '/assets/{assetId}/retire', tags: t })
      .input(ws.extend({ assetId: z.uuid(), ...DispositionInput.shape }))
      .output(Asset),
    /**
     * It turned up, or the write-off was a mistake. Clears the disposition and hands `status` back
     * to custody and repairs, so an item found under a desk reads `assigned` again without anybody
     * re-recording the handover. Refuses an item that has no disposition to clear.
     */
    reinstate: baseContract
      .route({ method: 'POST', path: '/assets/{assetId}/reinstate', tags: t })
      .input(ws.extend({ assetId: z.uuid(), ...DispositionInput.shape }))
      .output(Asset),
  },

  /**
   * A workspace's own fields on an asset — a cost centre, a supplier reference, a MAC address.
   *
   * Not behind a capability, and deliberately: a workspace that defines no field sees nothing — no
   * section on the form, no rows on the panel — so the feature switches itself off by being empty,
   * and a second switch would be one that changes nothing. Reading rides `inventory.asset.view`
   * because the asset form and the panel need the definitions to render a value; writing is
   * `inventory.field.manage`, workspace configuration like categories.
   *
   * Not paged, like categories, and for the same reason: every field has to be on the form anyway.
   */
  fields: {
    list: baseContract
      .route({ method: 'GET', path: '/fields', tags: t })
      .input(ws.extend({ archived: z.boolean().default(false) }))
      .output(z.array(FieldDef)),
    create: baseContract
      .route({ method: 'POST', path: '/fields', tags: t })
      .input(ws.extend(FieldCreateInput.shape))
      .output(FieldDef),
    /**
     * Everything but the key and the type, which a value already written cannot survive changing.
     *
     * Renaming an option keeps the old word on every asset that chose it — the value *is* the word.
     * Removing one does the same. The settings screen says so beside the list.
     */
    update: baseContract
      .route({ method: 'PATCH', path: '/fields/{fieldId}', tags: t })
      .input(ws.extend({ fieldId: z.uuid(), ...FieldPatchInput.shape }))
      .output(FieldDef),
    /** Archive, not delete — values written under the key stay readable — and the same procedure restores. */
    archive: baseContract
      .route({ method: 'POST', path: '/fields/{fieldId}/archive', tags: t })
      .input(ws.extend({ fieldId: z.uuid(), archived: z.boolean().default(true) }))
      .output(FieldDef),
    /** The whole live sequence, exactly as `categories.reorder` takes it, with the same refusals. */
    reorder: baseContract
      .route({ method: 'POST', path: '/fields/reorder', tags: t })
      .input(ws.extend({ fieldIds: z.array(z.uuid()).min(1).max(MAX_LIVE_FIELDS) }))
      .output(z.array(FieldDef)),
  },

  /**
   * Who is holding what.
   *
   * Four verbs rather than one, because "hand it to somebody" and "hand it on to somebody else" are
   * different questions with different failure modes: assigning something already out is a mistake
   * worth refusing, and transferring something nobody holds is a different mistake. One procedure
   * taking `userId | null` would answer both by silently doing whatever the row happened to allow.
   */
  custody: {
    /** Hand a free item to a member. Refuses if somebody already has it — that is `transfer`. */
    assign: baseContract
      .route({ method: 'POST', path: '/assets/{assetId}/custody', tags: t })
      .input(ws.extend({ assetId: z.uuid(), userId: z.uuid(), note: custodyNote }))
      .output(CustodyResult),
    /** Take it back. Closes the open period and puts the asset back in stock. */
    return: baseContract
      .route({ method: 'POST', path: '/assets/{assetId}/custody/return', tags: t })
      .input(ws.extend({ assetId: z.uuid(), note: custodyNote }))
      .output(CustodyResult),
    /**
     * Hand it straight on: one transaction, not a return followed by an assign.
     *
     * Two calls would leave the asset `in_stock` with no custodian in between — visible to anybody
     * reading the list at that moment, and permanently visible in the timeline as a return that
     * nobody performed.
     */
    transfer: baseContract
      .route({ method: 'POST', path: '/assets/{assetId}/custody/transfer', tags: t })
      .input(ws.extend({ assetId: z.uuid(), userId: z.uuid(), note: custodyNote }))
      .output(CustodyResult),
    /**
     * Every period for one asset, newest first — "who had this laptop before me".
     *
     * An array rather than a page, like HR's `employment.history`: the rows are bounded by how many
     * times one item changed hands, which is tens over its life. `limit` caps it rather than
     * paging, so the answer is never unbounded and the caller never has a cursor to keep.
     */
    history: baseContract
      .route({ method: 'GET', path: '/assets/{assetId}/custody', tags: t })
      .input(ws.extend({ assetId: z.uuid(), limit: z.number().int().min(1).max(200).default(100) }))
      .output(z.array(CustodyPeriod)),
    /**
     * What one person is holding right now.
     *
     * Answered from `assets.custodian_user_id` — denormalised inside the same transaction that
     * writes the period, and indexed — rather than from an open-period join, so the offboarding
     * question ("what does Ada still have?") is one indexed read.
     */
    byUser: baseContract
      .route({ method: 'GET', path: '/custody/by-user/{userId}', tags: t })
      .input(ws.extend({ userId: z.uuid(), ...PageInput.shape }))
      .output(page(Asset)),
  },

  /**
   * How a workspace groups what it owns.
   *
   * Not paged: a workspace has tens of categories, and every one of them has to be in the picker
   * anyway. A cursor here would be a page boundary in a dropdown.
   */
  categories: {
    list: baseContract
      .route({ method: 'GET', path: '/categories', tags: t })
      .input(ws.extend({ archived: z.boolean().default(false) }))
      .output(z.array(Category)),
    create: baseContract
      .route({ method: 'POST', path: '/categories', tags: t })
      .input(ws.extend(CategoryInput.shape))
      .output(Category),
    update: baseContract
      .route({ method: 'PATCH', path: '/categories/{categoryId}', tags: t })
      .input(ws.extend({ categoryId: z.uuid(), ...CategoryInput.partial().shape }))
      .output(Category),
    /**
     * Archive, not delete — and the same procedure restores.
     *
     * `assets.category_id` carries no foreign key, so a delete would leave every asset filed under
     * it pointing at nothing: a blank column, and a timeline entry that recorded the move losing
     * the name it recorded. Archiving is reversible and destroys nothing.
     */
    archive: baseContract
      .route({ method: 'POST', path: '/categories/{categoryId}/archive', tags: t })
      .input(ws.extend({ categoryId: z.uuid(), archived: z.boolean().default(true) }))
      .output(Category),
    /**
     * The whole sequence, in the order somebody put it in — the only thing that writes `order`.
     *
     * **The ids, not positions.** A position number is a database column with a form around it: two
     * categories can hold the same one, nobody thinks about their filing as integers, and the screen
     * that asked for one had to explain how ties break. A list of ids says exactly what the person
     * did, whatever they did it with — a drag, or the move-up and move-down buttons beside it.
     *
     * **It must name every live category the workspace has, exactly once.** A partial list is not
     * treated as "leave the rest alone": somebody added a category in another tab while this page
     * was open, and the ordering in hand no longer describes the workspace. Renumbering what it does
     * name would drop the new one somewhere nobody chose, silently — so the whole call is refused
     * with `inventory.category.order_stale` and the page reloads and asks again. Naming an archived
     * category is the same mistake from the other side and gets the same answer; an id from another
     * workspace is `NOT_FOUND`, exactly as `update` and `archive` answer for one.
     *
     * Answers the live sequence as it now stands, so a caller needs no second read.
     *
     * **The bound is `MAX_LIVE_CATEGORIES`, and it is the same number `create` refuses at.** A bound
     * on this array with nothing enforcing it elsewhere is a silent ceiling: a workspace could grow
     * past it one category at a time and then find that the only procedure that can order them is
     * the one it can no longer call. Held to the same number at the point of creation, the array can
     * always name every live category a workspace is allowed to have.
     */
    reorder: baseContract
      .route({ method: 'POST', path: '/categories/reorder', tags: t })
      .input(ws.extend({ categoryIds: z.array(z.uuid()).min(1).max(MAX_LIVE_CATEGORIES) }))
      .output(z.array(Category)),
  },

  /**
   * What went away to be fixed.
   *
   * **Behind the `repairs` capability**, which is this module's first switchable one — so every
   * procedure here answers **404** rather than 403 in a workspace that has it off. 403 would say
   * "this exists and you may not have it", which is false for a company that does not record
   * repairs, and it would contradict a panel that has already hidden the tab.
   *
   * Writing takes `inventory.repair.manage`; reading rides `inventory.asset.view`, for the reason
   * custody does — "where is the projector" is the question the register exists to answer.
   */
  repairs: {
    /**
     * One asset's repairs, or the whole workspace's — the same procedure, because they are the same
     * query with one filter and a second one would be a second thing to keep in step.
     *
     * `open: true` is the "what is away right now" question a dashboard card asks, and it is a
     * filter rather than a procedure of its own for the same reason.
     *
     * Paged, unlike `custody.history`: one asset's repairs are bounded by how often it breaks, but
     * a workspace's are not. Ordered newest-logged first, by row id — a uuidv7 already carries the
     * clock and is unique, where `sent_on` is a date two repairs logged the same day share.
     */
    list: baseContract
      .route({ method: 'GET', path: '/repairs', tags: t })
      .input(
        ws.extend({
          ...PageInput.shape,
          assetId: z.uuid().optional(),
          /** `true` for still away, `false` for finished, absent for both. */
          open: z.boolean().optional(),
        }),
      )
      .output(page(RepairListItem)),
    /**
     * Send it away. Refuses when the item is already at a repairer — one open repair per asset, and
     * `inventory_repairs_one_open_uq` is what makes that true in the database rather than merely
     * likely in the service.
     *
     * `sentOn` is optional and defaults to today **on the server**: a browser clock is not a fact
     * this module is willing to record, and the same reasoning already keeps asset tags server-side.
     */
    create: baseContract
      .route({ method: 'POST', path: '/assets/{assetId}/repairs', tags: t })
      .input(ws.extend({ assetId: z.uuid(), ...RepairInput.shape }))
      .output(RepairResult),
    /**
     * Correct what was recorded — a vendor, a cost that arrived with the invoice a week later.
     *
     * Deliberately cannot set `returnedOn`: that one column decides whether the asset reads as
     * `under_repair`, so exactly one procedure moves it and the derived status has one door rather
     * than two.
     */
    update: baseContract
      .route({ method: 'PATCH', path: '/repairs/{repairId}', tags: t })
      .input(ws.extend({ repairId: z.uuid(), ...RepairPatchInput.shape }))
      .output(RepairResult),
    /**
     * It came back. Closes the repair and puts the asset back to `assigned` if somebody still holds
     * it, or `in_stock` if nobody does — never blindly to `in_stock`, which would quietly release
     * whoever is answerable for it.
     *
     * Takes the cost, because that is when the invoice usually arrives.
     */
    complete: baseContract
      .route({ method: 'POST', path: '/repairs/{repairId}/complete', tags: t })
      .input(
        ws.extend({
          repairId: z.uuid(),
          returnedOn: z.iso.date().optional(),
          costMinor: z.number().int().min(0).nullish(),
          currency: z.string().length(3).nullish(),
        }),
      )
      .output(RepairResult),
  },

  /**
   * Receipts, warranties, manuals — and the asset's photo, which is an `Asset` field rather than one
   * of these.
   *
   * **Behind the `attachments` capability**, so these answer 404 in a workspace that has it off.
   *
   * **A module does not upload.** The browser sends the bytes to core's file service and hands this
   * module the id core gave it; `add` records that this asset has that file. Nothing here streams,
   * signs or stores anything, and `remove` detaches rather than deleting core's file — the same
   * bytes may be attached elsewhere, and a module has no standing to destroy another module's row.
   */
  attachments: {
    /**
     * Every file on one asset, its repairs' included, each carrying its own `repairId`.
     *
     * Not paged and not filtered by repair: one asset's files are bounded and entirely loaded, so
     * the panel groups them in the browser. That is the one case where filtering client-side is
     * right, and it is the opposite of what `assets.list` may do.
     */
    list: baseContract
      .route({ method: 'GET', path: '/assets/{assetId}/attachments', tags: t })
      .input(ws.extend({ assetId: z.uuid() }))
      .output(z.array(Attachment)),
    /** Attach files core already holds. `repairId` files them under one repair instead of the asset. */
    add: baseContract
      .route({ method: 'POST', path: '/assets/{assetId}/attachments', tags: t })
      .input(
        ws.extend({
          assetId: z.uuid(),
          fileIds: z.array(z.uuid()).min(1).max(20),
          repairId: z.uuid().nullish(),
        }),
      )
      .output(z.array(Attachment)),
    /** Answers with the id it detached, so a client can drop exactly that row without re-reading. */
    remove: baseContract
      .route({ method: 'DELETE', path: '/attachments/{attachmentId}', tags: t })
      .input(ws.extend({ attachmentId: z.uuid() }))
      .output(z.object({ id: z.uuid() })),
  },

  /**
   * The register in numbers.
   *
   * One procedure rather than a `total` on `assets.list`, because they answer different questions:
   * a list's total describes the filter you asked for, and this describes the workspace. The assets
   * page needs both — "showing 50 of 214" is two numbers from two places.
   *
   * Not behind a capability: it counts assets, which is `core`. `outForRepair` comes back null
   * rather than 0 where `repairs` is off — see `InventoryStats`.
   */
  stats: {
    summary: baseContract.route({ method: 'GET', path: '/stats', tags: t }).input(ws).output(InventoryStats),
  },
}
export type InventoryContract = typeof inventoryContract
