<script lang="ts">
import {
  Badge,
  Button,
  coreApi,
  Dialog,
  DropdownMenu,
  EmptyState,
  formatDate,
  IconButton,
  Input,
  keys,
  type MenuItem,
  navigation,
  Page,
  PageHeader,
  Select,
  type SelectOption,
  Skeleton,
  Switch,
  session,
  Table,
  TableCell,
  TableHeader,
  TableRow,
  toast,
} from '@kernhq/ui'
import { createInfiniteQuery, createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import type { Asset, AssetSort, AssetStatus, Category } from '../../contract/index.js'
import { getInventoryApi } from '../api-instance.js'
import { isolated } from '../bidi.js'
import AssetDetailPanel from '../components/AssetDetailPanel.svelte'
import AssetFormDialog from '../components/AssetFormDialog.svelte'
import DispositionDialog from '../components/DispositionDialog.svelte'
import type { CoreApi, CoreMember } from '../core-api.js'
import { type DispositionAction, dispositionActions } from '../disposition.js'
import { errorMessage } from '../errors.js'
import { t } from '../i18n.js'
import { ASSET_PARAM, CUSTODIAN_PARAM } from '../links.js'
import { directory, directoryStatus, nameOf } from '../members.js'
import { canInventory } from '../permissions.js'
import { inventoryKeys } from '../query.js'
import { statusTone } from '../status.js'

/**
 * This module's screen.
 *
 * The shell passes `workspaceId` and `workspaceSlug`, and `params` for any `:name` segment the
 * route declared. **Do not read `$app/state` or `$app/navigation`** — they are SvelteKit aliases,
 * this package is type-checked on its own, and they resolve only because the app happens to be
 * compiling you. Ask `navigation` from `@kernhq/ui` for the current location instead.
 */
interface Props {
  workspaceId: string
  workspaceSlug: string
  params?: Record<string, string>
}
const { workspaceId }: Props = $props()

const api = getInventoryApi()
const core = coreApi<CoreApi>()
const queryClient = useQueryClient()

let searchText = $state('')
let statusFilter = $state<string>('')
let categoryFilter = $state<string>('')
/**
 * How the list is ordered. A string rather than an `AssetSort`, because that is what `Select`
 * binds; it is narrowed where it enters the request, and the only values it can hold are the ones
 * `sortOptions` offers.
 */
let sortChoice = $state<string>('recent')
let showArchived = $state(false)
let dialogOpen = $state(false)
/** The row the dialog is editing, or null when it is adding one. */
let editingAsset = $state<Asset | null>(null)
/** The row awaiting an archive confirmation. */
let archiving = $state<Asset | null>(null)

// Debounce the search into the cache key, so typing does not refetch per keystroke.
let query = $state('')
$effect(() => {
  const value = searchText
  const timer = setTimeout(() => (query = value), 250)
  return () => clearTimeout(timer)
})

/**
 * The two filters that live in the URL rather than in this component.
 *
 * `?asset=<id>` is which panel is open, and `?custodian=<userId>` is "what is this person holding"
 * — the return list an offboarding notification links to. Both are in the URL for the same reason:
 * they are places somebody went, so they survive a reload, can be shared with the person who has to
 * act on them, and close on Back. Built from `navigation` because a module cannot read `$app/state`
 * — it is a SvelteKit alias, and this package is type-checked on its own.
 */
const params = $derived(new URLSearchParams(navigation.search))
const custodianFilter = $derived(params.get(CUSTODIAN_PARAM) ?? '')

/**
 * Every filter is part of the key and part of the request — and so is the sort.
 *
 * Filtering in the browser is only ever right for a list that is entirely loaded, and this one is
 * paged: dropping archived rows client-side returned twenty rows, showed eleven, and made the list
 * look short rather than paged. The sort is in here for a stricter reason: a page cursor is a
 * bookmark *into one ordering*, and the server refuses a cursor issued under another. Keying the
 * cache on the sort is what makes changing it start a fresh list rather than hand page two of the
 * old ordering a marker the new one cannot read.
 */
const filters = $derived({
  ...(query ? { q: query } : {}),
  ...(statusFilter ? { status: statusFilter as AssetStatus } : {}),
  ...(categoryFilter ? { categoryId: categoryFilter } : {}),
  ...(custodianFilter ? { custodianUserId: custodianFilter } : {}),
  archived: showArchived,
  sort: sortChoice as AssetSort,
})

/**
 * Whether anything is *narrowing* the list.
 *
 * The archived switch is not in here: it widens the list rather than narrowing it, so a workspace
 * with no assets and the switch on is still empty rather than filtered, and offering to "clear" it
 * would hide rows somebody just asked to see. The custodian **is** in here, so the count line stops
 * claiming the workspace total the moment the list is one person's.
 */
const narrowed = $derived(
  Boolean(query) || Boolean(statusFilter) || Boolean(categoryFilter) || Boolean(custodianFilter),
)

function clearFilters() {
  searchText = ''
  query = ''
  statusFilter = ''
  categoryFilter = ''
  setParam(CUSTODIAN_PARAM, null)
}

/**
 * The people this workspace has, asked for only when there is a uuid on screen to turn into a name.
 *
 * The same key `AssetDetailPanel` uses, so opening a panel afterwards costs no second request — and
 * no request at all in the ordinary case, where nothing is filtered by custodian.
 */
const membersQuery = createQuery(() => ({
  queryKey: keys.members(workspaceId),
  queryFn: () => core.workspaces.members.list({ workspaceId }),
  enabled: Boolean(workspaceId) && Boolean(custodianFilter),
}))
const dir = $derived(
  directory((membersQuery.data?.items ?? []) as CoreMember[], directoryStatus(membersQuery)),
)
/**
 * Whose list this is.
 *
 * `nameOf` never answers with the uuid: somebody who has since been removed from the workspace
 * reads as "a former member", which is exactly the case this filter exists for — the offboarding
 * notification is *about* somebody who has left.
 *
 * It only says so once the member list has actually arrived. Before that this line claimed the
 * person had left the workspace while their name was still being fetched, on the one screen whose
 * whole purpose is to be *about* a named person.
 */
const custodianName = $derived(
  custodianFilter
    ? nameOf(custodianFilter, dir, {
        loading: t('member_loading'),
        unknown: t('member_unknown'),
        former: t('member_former'),
        system: t('member_system'),
      })
    : null,
)

interface AssetPage {
  items: Asset[]
  nextCursor: string | null
  /** `page()` in `@kernhq/contracts` declares it; this module's server does not fill it yet. */
  total?: number
}

const assetsQuery = createInfiniteQuery(() => ({
  queryKey: inventoryKeys.assets(workspaceId, filters),
  queryFn: ({ pageParam }): Promise<AssetPage> =>
    api.assets.list({
      workspaceId,
      ...filters,
      ...(pageParam ? { cursor: pageParam as string } : {}),
    }) as Promise<AssetPage>,
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last: AssetPage) => last.nextCursor ?? undefined,
  enabled: Boolean(workspaceId),
}))

const assets = $derived(assetsQuery.data?.pages.flatMap((page) => page.items) ?? [])

/**
 * The workspace's categories, **archived ones included**.
 *
 * One query rather than two, and it asks for everything because the two things it feeds want
 * different halves: the chip on a row has to name the category an asset carries even after somebody
 * archived it — that is the whole point of archiving rather than deleting — while the filter offers
 * only the live ones, because filtering by something nobody can file anything under is a dead end.
 *
 * The key is the same one `AssetDetailPanel` uses, so opening a panel costs no second request.
 */
const categoriesQuery = createQuery(() => ({
  queryKey: inventoryKeys.categories(workspaceId, true),
  queryFn: () => api.categories.list({ workspaceId, archived: true }),
  enabled: Boolean(workspaceId),
}))
const categories = $derived<Category[]>(categoriesQuery.data ?? [])
const categoryNames = $derived(new Map(categories.map((row) => [row.id, row.name])))

/**
 * What the filter offers: the live categories, plus whichever one is currently chosen.
 *
 * The second half matters exactly once, and it is not hypothetical — somebody filters by "Cameras",
 * an administrator archives it in another tab, and without this the control would show an empty
 * value while the list stayed filtered. A filter that does not say what it is filtering by is worse
 * than one offering a category nobody can file anything new under.
 */
const categoryOptions = $derived<SelectOption[]>([
  { value: '', label: t('filter_all_categories') },
  ...categories
    .filter((row) => !row.archivedAt || row.id === categoryFilter)
    .map((row) => ({ value: row.id, label: row.name })),
])

// ------------------------------------------------------------------- the panel, and the URL

/**
 * Which asset is open lives in the URL, not in this component's state. See `params` above.
 *
 * The parameter's name comes from `links.ts`, which is also where a dashboard card builds the link
 * that sets it — one constant, so a card cannot send somebody to a URL this page ignores.
 */
const openAssetId = $derived(params.get(ASSET_PARAM))

/**
 * Set or clear one search parameter, leaving every other one alone.
 *
 * One function rather than one per parameter, because "keep the rest of the URL" is the part that
 * is easy to get wrong: clearing the custodian filter by rebuilding the query string from scratch
 * would close the panel somebody has open.
 *
 * A push, deliberately — not the `replaceState` a filter change would use. Opening a panel, and
 * arriving on somebody's return list from a notification, are both places somebody went, so Back
 * should undo them; a keystroke in the search box is not, and a list that pushed every one of those
 * would fill the back button with states nobody meant to visit.
 */
function setParam(name: string, value: string | null) {
  const next = new URLSearchParams(navigation.search)
  if (value) next.set(name, value)
  else next.delete(name)
  const search = next.toString()
  void navigation.go(`${navigation.pathname}${search ? `?${search}` : ''}`, {
    keepFocus: true,
    noScroll: true,
  })
}

const setAsset = (id: string | null) => setParam(ASSET_PARAM, id)

/**
 * The register in numbers, for the one line that has to be a number.
 *
 * One request for the whole workspace rather than a `count(*)` bolted onto every page of a keyset
 * list — which is the expensive way to answer a question that does not change between pages.
 */
const statsQuery = createQuery(() => ({
  queryKey: inventoryKeys.stats(workspaceId),
  queryFn: () => api.stats.summary({ workspaceId }),
  enabled: Boolean(workspaceId),
}))

/**
 * A count that stays true while the list pages.
 *
 * `t('count', { n: assets.length })` counted the pages *loaded*, so 120 assets read "50 assets" and
 * then "100 assets" after Load more — a number that is simply wrong, on the line whose whole job is
 * to be the number.
 *
 * Three answers, in order of how true they are. **The workspace total** when nothing is narrowing
 * the list and archived rows are out, because then the list *is* every live asset and
 * `stats.summary` has counted them. **What the server said** if it ever fills `total` on a page.
 * Otherwise how many are being *shown*, which is honest about being a partial answer rather than
 * claiming a filtered, half-loaded list is all there is.
 */
const reportedTotal = $derived(assetsQuery.data?.pages.at(-1)?.total)
const workspaceTotal = $derived(!narrowed && !showArchived ? statsQuery.data?.total : undefined)
const countLine = $derived(
  workspaceTotal !== undefined
    ? t('count', { n: workspaceTotal })
    : reportedTotal !== undefined
      ? t('count', { n: reportedTotal })
      : assetsQuery.hasNextPage
        ? t('count_showing', { n: assets.length })
        : t('count', { n: assets.length }),
)

/**
 * Every status the register can actually produce.
 *
 * Five of the contract's six: `in_stock` and `assigned` are written by custody, `under_repair` by
 * a repair, and `lost` and `retired` by hand — `assets.markLost` and `assets.retire`. `reserved`
 * is the one left out, because it waits on reservations and nothing records one: a filter that
 * can only ever answer with an empty list is a door that will not open, and the status is still
 * in the enum so that the day something writes it, the badge and its colour are already there.
 */
const statusOptions: SelectOption[] = [
  { value: '', label: t('filter_all_statuses') },
  { value: 'in_stock', label: t('status_in_stock') },
  { value: 'assigned', label: t('status_assigned') },
  { value: 'under_repair', label: t('status_under_repair') },
  { value: 'lost', label: t('status_lost') },
  { value: 'retired', label: t('status_retired') },
]

/**
 * The three orderings `AssetSort` names, with `recent` first because it is the contract's default
 * and what the list opens on. Written as literals rather than built from the enum so that
 * `messages.test.ts` can see each key is asked for.
 */
const sortOptions: SelectOption[] = [
  { value: 'recent', label: t('sort_recent') },
  { value: 'name', label: t('sort_name') },
  { value: 'code', label: t('sort_code') },
]

// ---------------------------------------------------------------- row actions

/**
 * `assets.update` and `assets.archive` had no entry point anywhere in this module.
 *
 * Three of five procedures were unreachable and the module had one screen, so an asset could be
 * created and then never corrected — a typo in a name was permanent, and a laptop that left the
 * company stayed in the register for ever.
 */
let acting = $state(false)

/** Archive and restore are one procedure, so they are one mutation and one busy flag. */
interface ArchiveVars {
  assetId: string
  archived: boolean
  name: string
}

const setArchived = createMutation(() => ({
  mutationFn: (vars: ArchiveVars) =>
    api.assets.archive({ workspaceId, assetId: vars.assetId, archived: vars.archived }),
  onSuccess: (_saved: Asset, vars: ArchiveVars) => {
    toast.success(t(vars.archived ? 'archived_toast' : 'restored_toast', isolated({ name: vars.name })))
    void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
    archiving = null
  },
  // Not `error.message`: that is a sentence the *server* wrote, in English, and archiving something
  // somebody is still holding is exactly the refusal a reader needs to understand. `errors.ts` maps
  // the reason token this module's server sends — `inventory.asset.still_held` — to a translated
  // sentence, and keeps the server's words only for a failure it does not recognise.
  onError: (error: unknown) => toast.error(errorMessage(error, t)),
  onSettled: () => {
    acting = false
  },
}))

/**
 * The guard is a plain flag set in the same tick as the click.
 *
 * `disabled={mutation.isPending}` reaches the button one render later, and two quick clicks are one
 * render apart — so on a confirmation it files two decisions.
 */
function confirmArchive() {
  const target = archiving
  if (!target || acting) return
  acting = true
  setArchived.mutate({ assetId: target.id, archived: true, name: target.name })
}

function restore(asset: Asset) {
  if (acting) return
  acting = true
  setArchived.mutate({ assetId: asset.id, archived: false, name: asset.name })
}

function openCreate() {
  editingAsset = null
  dialogOpen = true
}

function openEdit(asset: Asset) {
  editingAsset = asset
  dialogOpen = true
}

/**
 * The row whose fate is being decided, and which of the three verbs was chosen. Both null when
 * the dialog is closed; `DispositionDialog` states what happens and takes the note.
 */
let disposing = $state<Asset | null>(null)
let dispositionAction = $state<DispositionAction | null>(null)

function openDisposition(asset: Asset, action: DispositionAction) {
  disposing = asset
  dispositionAction = action
}

/**
 * Restoring is not destructive and needs no confirmation; archiving is, and states what happens.
 * Hidden rather than disabled for somebody without `manage`: they may never do it, so the menu is
 * not there at all rather than being a door that will not open.
 *
 * What happened to the item sits between *Edit* and *Archive*: marking it lost is an ordinary
 * statement and goes with the ordinary items; retiring it is the write-off, wears the danger
 * colour and sits with archiving, after the separator, because those are the two things that
 * take an item out of use. A disposed row offers *Reinstate* in place of both — `dispositionActions`
 * decides, and the panel reads the same answer.
 */
function actionsFor(asset: Asset): MenuItem[] {
  const items: MenuItem[] = [
    // The name in the row is already a button that opens this; the menu carries it too because a
    // menu that lists everything a row can do is the one place somebody looks for what a row can do.
    { label: t('open'), icon: 'arrow-right', onSelect: () => setAsset(asset.id) },
    { label: t('common.edit'), icon: 'square-pen', onSelect: () => openEdit(asset) },
  ]
  if (asset.archivedAt) {
    items.push({ label: t('restore'), icon: 'rotate-ccw', onSelect: () => restore(asset) })
    return items
  }
  const fate = dispositionActions({ disposition: asset.disposition, archived: false, may: true })
  if (fate.includes('reinstate'))
    items.push({
      label: t('reinstate'),
      icon: 'refresh-cw',
      onSelect: () => openDisposition(asset, 'reinstate'),
    })
  if (fate.includes('lost'))
    items.push({ label: t('mark_lost'), icon: 'circle-help', onSelect: () => openDisposition(asset, 'lost') })
  items.push({ type: 'separator' })
  if (fate.includes('retire'))
    items.push({
      label: t('retire'),
      icon: 'circle-x',
      danger: true,
      onSelect: () => openDisposition(asset, 'retire'),
    })
  items.push({
    label: t('common.archive'),
    icon: 'archive',
    danger: true,
    onSelect: () => (archiving = asset),
  })
  return items
}

const workspaceName = $derived(session.workspaces.find((w) => w.id === workspaceId)?.name ?? '')
const canManage = $derived(canInventory('manage'))
/** The last column carries the row menu, and only exists when there is a menu to carry. */
const COLUMNS = $derived(
  canManage
    ? 'minmax(96px, 110px) minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) 132px 44px'
    : 'minmax(96px, 110px) minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) 132px',
)
const SKELETON_ROWS = [0, 1, 2, 3, 4, 5]
</script>

<PageHeader crumbs={[{ label: workspaceName }, { label: t('title') }]} title={t('title')}>
  {#snippet search()}
    <Input
      bind:value={searchText}
      type="search"
      size="sm"
      placeholder={t('search_placeholder')}
      aria-label={t('search_placeholder')}
    />
  {/snippet}
  {#snippet actions()}
    <Select
      bind:value={categoryFilter}
      options={categoryOptions}
      size="sm"
      ariaLabel={t('category')}
    />
    <Select bind:value={statusFilter} options={statusOptions} size="sm" ariaLabel={t('status')} />
    <Select bind:value={sortChoice} options={sortOptions} size="sm" ariaLabel={t('sort')} />
    {#if canManage}
      <Button size="sm" icon="plus" onclick={openCreate}>{t('new')}</Button>
    {/if}
  {/snippet}
</PageHeader>

<Page>
  <!--
    The return list, when somebody arrived here from an offboarding notification.
    Named rather than silent: a list that has quietly dropped nine tenths of the register with no
    sentence saying why is the single most confusing thing a filter can do, and this one is not set
    by any control on the page — it came in on the URL.
  -->
  {#if custodianFilter}
    <div class="held-by">
      <span>{t('held_by', isolated({ name: custodianName ?? '' }))}</span>
      <Button size="sm" variant="ghost" onclick={() => setParam(CUSTODIAN_PARAM, null)}>
        {t('held_by_clear')}
      </Button>
    </div>
  {/if}

  <div class="bar">
    <p class="count" aria-live="polite">{countLine}</p>
    <Switch bind:checked={showArchived} size="sm" label={t('show_archived')} />
  </div>

  {#if assetsQuery.isPending}
    <!-- Shaped like the table it is standing in for, not a spinner in the middle of a content
         area: the page does not jump when the rows arrive, and the shape says what is coming. -->
    <div class="skeleton">
      {#each SKELETON_ROWS as row (row)}
        <div class="srow" style:grid-template-columns={COLUMNS}>
          <Skeleton height="12px" width="72%" />
          <Skeleton height="12px" width="58%" />
          <Skeleton height="12px" width="46%" />
          <Skeleton height="12px" width="40%" />
          <Skeleton height="18px" width="76px" radius="999px" />
          {#if canManage}<Skeleton height="12px" width="16px" />{/if}
        </div>
      {/each}
    </div>
  {:else if assetsQuery.isError}
    <!-- An error needs a message *and* a way out of it. This was a bare red sentence. -->
    <EmptyState icon="triangle-alert" title={t('load_error')} description={t('common.error')}>
      {#snippet actions()}
        <Button variant="secondary" onclick={() => void assetsQuery.refetch()}>
          {t('common.retry')}
        </Button>
      {/snippet}
    </EmptyState>
  {:else if assets.length === 0 && narrowed}
    <!-- A search that matched nothing used to say "No assets yet · Add the first laptop…" beside a
         New asset button — the wrong sentence and the wrong action for a workspace full of them. -->
    <EmptyState icon="search" title={t('no_matches')} description={t('no_matches_desc')}>
      {#snippet actions()}
        <Button variant="secondary" onclick={clearFilters}>{t('clear_filters')}</Button>
      {/snippet}
    </EmptyState>
  {:else if assets.length === 0}
    <EmptyState icon="briefcase" title={t('empty')} description={t('empty_desc')}>
      {#snippet actions()}
        {#if canManage}
          <Button onclick={openCreate}>{t('new')}</Button>
        {/if}
      {/snippet}
    </EmptyState>
  {:else}
    <Table columns={COLUMNS} ariaLabel={t('title')}>
      <TableHeader>
        <TableCell header>{t('code')}</TableCell>
        <TableCell header>{t('name')}</TableCell>
        <TableCell header>{t('location')}</TableCell>
        <TableCell header>{t('warranty_until')}</TableCell>
        <TableCell header>{t('status')}</TableCell>
        {#if canManage}<TableCell header end></TableCell>{/if}
      </TableHeader>
      {#each assets as asset (asset.id)}
        <TableRow>
          <TableCell><code>{asset.code}</code></TableCell>
          <TableCell>
            <span class="stack">
              <!--
                A button rather than the whole row: a row carrying a menu cannot itself be a button
                without nesting one inside the other, which is invalid and breaks the menu. The name
                is what somebody aims at anyway, and it is reachable from the keyboard.
              -->
              <button
                type="button"
                class="name"
                onclick={() => setAsset(asset.id)}
                aria-label={t('open_asset', isolated({ name: asset.name }))}
              >
                {asset.name}
              </button>
              {#if asset.categoryId || asset.serialNumber}
                <span class="sub">
                  {#if asset.categoryId}
                    <!-- Named even when the category has since been archived: `categories` is
                         fetched with archived rows for exactly this. -->
                    <span class="chip">
                      {categoryNames.get(asset.categoryId) ?? t('category_none')}
                    </span>
                  {/if}
                  <!-- `S/N` was a literal English abbreviation sitting in the middle of a Persian,
                       Arabic, German or Turkish table; `serial_number` is translated in all five. -->
                  {#if asset.serialNumber}
                    <span class="serial">
                      {t('serial_number')}:
                      <span class="ltr">{asset.serialNumber}</span>
                    </span>
                  {/if}
                </span>
              {/if}
            </span>
          </TableCell>
          <TableCell><span class="muted">{asset.location ?? '—'}</span></TableCell>
          <!-- `formatDate`, not the stored value. This column printed the ISO string — 2027-03-14
               — beside a panel that renders the same field as "14 Mar 2027", so the same fact read
               two ways on one screen, and a Persian reader got Gregorian Latin digits in a table
               where every other date follows their calendar. -->
          <TableCell>
            <span class="muted">
              {asset.warrantyUntil ? formatDate(asset.warrantyUntil) : '—'}
            </span>
          </TableCell>
          <TableCell>
            {#if asset.archivedAt}
              <Badge tone="grey">{t('archived')}</Badge>
            {:else}
              <Badge tone={statusTone(asset.status)}>{t(`status_${asset.status}`)}</Badge>
            {/if}
          </TableCell>
          {#if canManage}
            <TableCell end>
              <DropdownMenu items={actionsFor(asset)} align="end">
                {#snippet trigger(props)}
                  <IconButton
                    {...props}
                    icon="ellipsis"
                    size={28}
                    label={t('row_actions', isolated({ name: asset.name }))}
                  />
                {/snippet}
              </DropdownMenu>
            </TableCell>
          {/if}
        </TableRow>
      {/each}
    </Table>

    {#if assetsQuery.hasNextPage}
      <div class="more">
        <Button
          size="sm"
          variant="secondary"
          disabled={assetsQuery.isFetchingNextPage}
          onclick={() => assetsQuery.fetchNextPage()}
        >
          {assetsQuery.isFetchingNextPage ? t('common.loading') : t('load_more')}
        </Button>
      </div>
    {/if}
  {/if}
</Page>

<AssetFormDialog bind:open={dialogOpen} {workspaceId} asset={editingAsset} />

<!--
  The panel sits over the list rather than replacing it: the scroll position, the filters and the
  page cursor are all still there when it closes. Editing is the list's own dialog, so the panel
  asks for it rather than growing a second copy of the form.
-->
<AssetDetailPanel
  {workspaceId}
  assetId={openAssetId}
  onclose={() => setAsset(null)}
  onedit={(asset) => openEdit(asset)}
/>

<!-- Lost, retired, and the way back. One dialog, and the list's own so the panel can share it. -->
<DispositionDialog
  {workspaceId}
  asset={dispositionAction ? disposing : null}
  action={dispositionAction}
  onclose={() => {
    disposing = null
    dispositionAction = null
  }}
/>

<!-- Archiving states what happens and to what, rather than asking "Are you sure?". -->
<Dialog
  open={archiving !== null}
  size="sm"
  title={t('archive_title', isolated({ name: archiving?.name ?? '' }))}
  onOpenChange={(next) => {
    if (!next) archiving = null
  }}
>
  <p class="dialog-body">{t('archive_body')}</p>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (archiving = null)}>{t('common.cancel')}</Button>
    <Button variant="danger" onclick={confirmArchive} loading={acting}>{t('common.archive')}</Button>
  {/snippet}
</Dialog>

<style>
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }
  .count {
    font-size: 12px;
    color: var(--kern-ink-280);
  }
  .held-by {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 10px;
    /* Logical, never left/right: the extra room is beside the text, which in Persian is the other
       side of the box. */
    padding-block: 8px;
    padding-inline: 12px 8px;
    border-radius: var(--kern-r-md);
    background: var(--kern-surface-chip);
    font-size: 13px;
    /* A colour rather than opacity, and 600 rather than 500: this sentence is the reason the list
       below it is short, so it is read rather than skimmed. */
    color: var(--kern-ink-600);
  }
  .muted {
    color: var(--kern-ink-280);
  }
  code {
    font-size: 12px;
    color: var(--kern-ink-600);
  }
  /* A tag and a serial are Latin identifiers read character by character. Inside a Persian or
     Arabic row the bidi algorithm will happily reorder a mixed letter-and-digit run, so they are
     isolated and left-to-right — the characters have to match what is printed on the sticker. */
  code,
  .ltr {
    direction: ltr;
    /* `isolate` works on an inline box; `inline-block` would also work and would cost the
       ellipsis on the line above it. */
    unicode-bidi: isolate;
  }
  .stack {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .name {
    /* A button that reads as the row's title: no chrome, the row's own type, and the pointer the
       design system already puts on every `button`. */
    appearance: none;
    background: none;
    border: 0;
    font: inherit;
    font-weight: 500;
    color: var(--kern-ink-900);
    text-align: start;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    /* WCAG 2.5.8 wants 24px; a line of 13px text is about 18. The padding grows the hit area and
       the equal negative margin gives the space back, so the margin box — and therefore the row —
       is exactly where it was. */
    padding-block: 4px;
    margin-block: -4px;
    /* So the global `:focus-visible` ring is rounded like every other control. */
    border-radius: var(--kern-r-sm);
    /* A value somebody typed decides its own direction: `plaintext` takes it from the value's
       first strong character, so a Latin name inside a Persian screen reads left to right and
       keeps its own trailing punctuation instead of donating it to the paragraph. */
    unicode-bidi: plaintext;
  }
  .name:hover {
    text-decoration: underline;
  }
  .sub {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: 11px;
    /* Muted with a colour, never with opacity: a faded row at 0.5 is unreadable whatever its token. */
    color: var(--kern-ink-280);
  }
  .chip {
    flex: none;
    /* A value somebody typed decides its own direction: `plaintext` takes it from the value's
       first strong character, so a Latin name inside a Persian screen reads left to right and
       keeps its own trailing punctuation instead of donating it to the paragraph. */
    unicode-bidi: plaintext;
    padding: 1px 6px;
    border-radius: var(--kern-r-sm);
    background: var(--kern-surface-chip);
    color: var(--kern-ink-600);
    max-inline-size: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .serial {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .skeleton {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .srow {
    display: grid;
    align-items: center;
    gap: 12px;
    /* The row heights of `Table`, so nothing shifts when the real rows replace these. */
    padding: 14px 12px;
    border-bottom: 1px solid var(--kern-border-hairline);
  }
  .more {
    display: flex;
    justify-content: center;
    padding: 16px 0;
  }
  .dialog-body {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--kern-ink-700);
  }
</style>
