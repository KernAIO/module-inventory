<script lang="ts">
import {
  Badge,
  Button,
  Dialog,
  DropdownMenu,
  EmptyState,
  Field,
  Icon,
  IconButton,
  Input,
  type MenuItem,
  messageLocale,
  navigation,
  SettingsPage,
  SettingsSection,
  Skeleton,
  Switch,
  session,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { untrack } from 'svelte'
import { dndzone, SHADOW_ITEM_MARKER_PROPERTY_NAME } from 'svelte-dnd-action'
import type { Category } from '../../contract/index.js'
import { getInventoryApi } from '../api-instance.js'
import { isolated } from '../bidi.js'
import { errorMessage, reasonOf } from '../errors.js'
import { t } from '../i18n.js'
import { INVENTORY_PERMISSIONS } from '../permissions.js'
import { inventoryKeys } from '../query.js'
import { placementOf } from '../reorder.js'
import {
  consider as considered,
  finalize as finalized,
  move as moved,
  refused,
  reseed,
  type Sequence,
  type Step,
  saved,
  seed,
  start,
} from '../sequence.js'

/**
 * How a workspace groups what it owns, and the order it groups them in.
 *
 * `assets.list` has taken a `categoryId` filter since the module existed and nothing could create a
 * category, so the filter had exactly one possible answer — this page is the other half of it.
 *
 * **The order is dragged, not typed.** This page used to carry a *Position* field: a number box on
 * the add-and-rename dialog, with a hint explaining that lower comes first and that two categories
 * sharing a number fall back to their names. That is a database column with a form around it.
 * Nobody arranges their filing by integer, the field invited the one state it then had to explain,
 * and moving a category two places meant working out a number that would land it there. It is a
 * list you drag now, and `categories.reorder` writes the whole sequence in one transaction.
 *
 * **A drag is a gesture, never a requirement.** It is unreachable by keyboard and by anybody who
 * cannot hold a pointer steady, so every row carries move-up and move-down buttons that do exactly
 * the same thing, and the result is spoken into a live region rather than moving in silence. Those
 * buttons are the *only* keyboard route: the drag library ships one of its own, and shipping both
 * left both half-working, so it is switched off — see `keepKeyboardOnTheButtons`.
 *
 * **Nothing here deletes.** `assets.category_id` carries no foreign key, so removing a row would
 * leave every asset filed under it pointing at nothing: a blank column, and a timeline entry saying
 * the category changed *to* a name it can no longer print. Archiving takes it out of every picker
 * and every filter and leaves each asset able to say what it is; the same procedure restores it.
 */
const api = getInventoryApi()
const queryClient = useQueryClient()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspaceId = $derived(session.workspaces.find((w) => w.slug === workspaceSlug)?.id ?? '')

/**
 * The permission the server enforces on every write here.
 *
 * The page is already gated on it in `module.ts`, so somebody without it never sees the entry —
 * but a settings URL can be typed, and a read-only view of the list is a better answer than a form
 * whose every button 403s.
 */
const canManage = $derived(session.can(INVENTORY_PERMISSIONS.categories))

let showArchived = $state(false)

/**
 * One query for every category, archived ones included, split here.
 *
 * Two things come out of that. It is the key `AssetsPage` and `AssetDetailPanel` already use, so
 * arriving at this page after either of them costs no request — and, the reason it changed, it is
 * the only way this page can tell **"no categories yet"** from **"every category is archived"**.
 * With `archived: showArchived` in the request the two are the same empty array, and the page told
 * a workspace that had archived all five of its categories that it had never made one — beside a
 * *New category* button, with the row that would have fixed it one switch away.
 */
const categoriesQuery = createQuery(() => ({
  queryKey: inventoryKeys.categories(workspaceId, true),
  queryFn: () => api.categories.list({ workspaceId, archived: true }),
  enabled: Boolean(workspaceId),
}))
const everything = $derived<Category[]>(categoriesQuery.data ?? [])

/**
 * The two lists, and why they are two.
 *
 * `live` is the sequence: it is what a person arranges, what every picker and filter shows, and the
 * exact set `categories.reorder` insists on being handed. An archived category is in none of those
 * places, so it has no position to arrange — putting it in the same draggable list would let
 * somebody carefully place a row that nobody but this page will ever see, between two rows it does
 * not sit between anywhere else. They get their own group, in their own order.
 *
 * Sorted with the reader's own collation rather than the runtime's: `localeCompare` with no locale
 * sorts Persian and Turkish names by whatever the browser happens to default to.
 */
const live = $derived(everything.filter((row) => !row.archivedAt))
const collator = $derived(new Intl.Collator(messageLocale()))
const archived = $derived(
  everything.filter((row) => row.archivedAt).sort((a, b) => collator.compare(a.name, b.name)),
)
/** Rows exist, and the switch is hiding all of them. A different sentence from having none. */
const allArchived = $derived(live.length === 0 && archived.length > 0 && !showArchived)

// ------------------------------------------------------------------------------- the sequence

const FLIP = 140

/**
 * The order on screen, the two snapshots behind it, and the two flags — one value, in `sequence.ts`.
 *
 * It lives next door rather than here because a `.svelte` file cannot be unit-tested in this package,
 * and every defect this screen has had was an *ordering* rather than a calculation: a keyboard drag
 * ending on a different event from a pointer drag, a refusal rolling back to a list the server had
 * already rejected, a keypress arriving while the last one was still being written. Each of those is
 * three assertions in `sequence.test.ts` and three careful readings here.
 *
 * `$state.raw` and not a plain `$state`: a deep-reactive proxy hands the drag library a different
 * object on every read, and it reads that as an endless stream of changes.
 */
let sequence = $state.raw<Sequence<Category>>(start<Category>([]))
let announcements = $state<[string, string]>(['', ''])
let pulse = false

/**
 * The library's own types want a mutable array, and its keyboard action really does splice the one
 * it is given — which is the route this screen switches off below. Nothing here ever mutates it.
 */
const rows = $derived(sequence.rows as Category[])

/**
 * Seed the sequence from the query, and *only* from it.
 *
 * `seed` declines while a drag or a save is in progress, so a refetch landing mid-gesture cannot pull
 * the list out from under the pointer or replace the optimistic order with data the write has not
 * reached yet. The flags are read inside `seed` rather than here, which is also what keeps them out
 * of this effect's dependencies: reading one directly would re-run the effect when it cleared, and
 * re-seed from a query the write has not reached.
 *
 * A skipped seed is dropped rather than queued, and the two ways back are deliberate: a successful
 * write answers with the sequence it wrote, and a refusal re-seeds from what the server actually has.
 *
 * **`untrack` around the read, or this effect feeds itself.** `seed` returns a new object, so an
 * effect that both reads and writes `sequence` invalidates its own dependency and Svelte stops it
 * with `effect_update_depth_exceeded` — at runtime, on a screen that type-checks perfectly. The one
 * thing this is allowed to react to is the query.
 */
$effect(() => {
  const next = live
  sequence = untrack(() => seed(sequence, next))
})

const isShadow = (category: Category) =>
  (category as unknown as Record<string, unknown>)[SHADOW_ITEM_MARKER_PROPERTY_NAME] === true

/** The reason token the server sends when the list no longer describes the workspace. */
const ORDER_STALE = 'inventory.category.order_stale'

const reorder = createMutation(() => ({
  mutationFn: (categoryIds: readonly string[]) =>
    api.categories.reorder({ workspaceId, categoryIds: [...categoryIds] }),
  onSuccess: (written: Category[]) => {
    // The server answers the sequence it wrote, so there is nothing to guess and no flash: the
    // optimistic list is replaced by the same list. When somebody kept pressing an arrow key while
    // this was in flight, `saved` hands back the list those presses add up to and it goes now —
    // one more request for any number of presses, and never one per keypress arriving out of order.
    take(saved(sequence, written))
    // Refreshes the picker on the asset form and the filter on the list, which read the same query.
    void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
  },
  /**
   * Say why, and — for the one refusal a person can act on — leave them able to act on it.
   *
   * A rollback alone is what made `order_stale` unrecoverable. It restores `settled`, which is the
   * list the server has just refused, and the seeding effect cannot replace it: that effect is keyed
   * on the query's data, and the refetch after the invalidation returns the value it already skipped
   * while the save was in flight. Same value, no change, no re-run — so every retry sent the same
   * stale list and earned the same refusal, under a message telling the reader to try again.
   *
   * So the invalidation is awaited and the list is re-seeded from what actually came back. Read out
   * of the cache rather than out of `live`, because that is the value this screen is about to be
   * given and reading it directly does not depend on anything having changed.
   */
  onError: async (error: unknown) => {
    toast.error(errorMessage(error, t))
    const stale = reasonOf(error) === ORDER_STALE
    sequence = refused(sequence)
    await queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
    if (!stale) return
    const fresh = queryClient.getQueryData<Category[]>(inventoryKeys.categories(workspaceId, true))
    if (fresh) sequence = reseed(fresh.filter((row) => !row.archivedAt))
  },
}))

/**
 * Adopt a transition, and do the work it leaves behind: post a list, speak a sentence, or neither.
 *
 * The three decisions themselves are in `sequence.ts`, with a test each. This is the wiring.
 */
function take(step: Step<Category>) {
  sequence = step.next
  if (step.announce) announce(step.announce.list, step.announce.id)
  if (step.save) reorder.mutate(step.save)
}

function move(category: Category, delta: number) {
  take(moved(sequence, category.id, delta))
}

function consider(event: CustomEvent<{ items: Category[]; info: { trigger: string } }>) {
  take(considered(sequence, event.detail.items, event.detail.info.trigger))
}

function finalize(event: CustomEvent<{ items: Category[]; info: { id: string } }>) {
  take(
    finalized(
      sequence,
      event.detail.items.filter((category) => !isShadow(category)),
      event.detail.info.id,
    ),
  )
}

/**
 * The keys `svelte-dnd-action` claims on a row, held back before they ever reach it.
 *
 * **This screen has one keyboard route to reordering, and it is the two buttons on each row.**
 *
 * The library ships a second one, and shipping both left both half-working. Its keyboard drag put a
 * tab stop on every row — a stop that announces nothing and does nothing until you know to press
 * Enter on it — and then fired a `finalize` on *every arrow key*, so moving a category three places
 * was three writes, of which the guard discarded two. It also ends on a `consider` rather than a
 * `finalize`, which is the event asymmetry `sequence.ts` exists to absorb.
 *
 * The house rule is that a drag must have a **non-drag equivalent**, not that the library's drag must
 * also be driveable from the keyboard. *Move up* and *move down* are that equivalent: they are real
 * buttons with real names, they are reachable in the same tab order as everything else on the page,
 * and one press is one move whatever the network is doing. So the library's keyboard route is turned
 * off rather than left as a worse duplicate of them — `zoneItemTabIndex: -1` takes the rows out of the
 * tab order, and this takes the trigger keys away from a row that has been focused by a click, which
 * is the one way left to reach it.
 *
 * In the capture phase on the list, because the library listens on each row: a capture handler on the
 * ancestor runs first, and `stopPropagation` there means the row's own listener never sees the key. It
 * only ever fires for a key pressed on a **row**; a key on a button inside one is somebody using the
 * controls, and passes straight through.
 */
const LIBRARY_DRAG_KEYS = new Set(['Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])

function keepKeyboardOnTheButtons(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  if (!target || target.parentElement !== event.currentTarget) return
  if (LIBRARY_DRAG_KEYS.has(event.key)) event.stopPropagation()
}

/**
 * What a screen reader is told, and why it never contains a number.
 *
 * "position 4 of 9" asks somebody to hold two numbers in their head to work out what a neighbour's
 * name says outright — and a number is the thing this page stopped showing. The sentence describes
 * where the row *is* rather than what just happened, so it is still true when the answer is that
 * the row could not move: pressing *move up* on the first row says it is first.
 */
function announce(list: readonly Category[], id: string) {
  const name = list.find((category) => category.id === id)?.name
  const spot = placementOf(list, id)
  if (name === undefined || spot.at === 'gone') return
  const sentence =
    spot.at === 'after'
      ? t('category_position_after', isolated({ name, other: spot.previous.name }))
      : t(spot.at === 'first' ? 'category_position_first' : 'category_position_last', isolated({ name }))
  /**
   * Two regions, written alternately, because one would fall silent.
   *
   * A live region announces a *change* to its text, and pressing *move down* twice on the row that
   * is already last produces the same sentence twice — so the second press would say nothing, which
   * reads as a broken button to the one person who cannot see that nothing moved. Filling one region
   * while emptying the other makes every announcement a change, whatever the words are. The
   * alternative trick is a trailing zero-width space, and it puts a character nobody can see into
   * the source for somebody to delete by accident.
   */
  pulse = !pulse
  announcements = pulse ? [sentence, ''] : ['', sentence]
}

// ------------------------------------------------------------------ the add / rename dialog

let editing = $state<Category | null>(null)
let dialogOpen = $state(false)
let name = $state('')

function openCreate() {
  editing = null
  name = ''
  dialogOpen = true
}

function openEdit(category: Category) {
  editing = category
  name = category.name
  dialogOpen = true
}

const canSubmit = $derived(canManage && Boolean(name.trim()))

/**
 * Set in the same tick as the click, for the reason `sequence.saving` above is: the attribute from
 * `disabled={mutation.isPending}` reaches the button on the next render, and two quick clicks are one
 * render apart — so a double-click would file the same category twice. Guarded rather than disabled,
 * because disabling the control somebody is standing on throws their focus out to the page.
 */
let saving = $state(false)

const save = createMutation(() => ({
  mutationFn: () => {
    const row = editing
    const values = { name: name.trim() }
    return row
      ? api.categories.update({ workspaceId, categoryId: row.id, ...values })
      : api.categories.create({ workspaceId, ...values })
  },
  onSuccess: (saved: Category) => {
    toast.success(
      t(editing ? 'category_updated_toast' : 'category_created_toast', isolated({ name: saved.name })),
    )
    void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
    dialogOpen = false
  },
  // The server's sentence is the actionable one and it is in English — "This workspace already has
  // a category called “Laptops”." was shown verbatim to a reader who chose Persian. The token it
  // carries, `inventory.category.name_taken`, is the part a client can translate; the name is on
  // screen in the box directly above the message, so the sentence does not need to repeat it.
  onError: (error: unknown) => toast.error(errorMessage(error, t)),
  onSettled: () => {
    saving = false
  },
}))

function submit() {
  if (saving || !canSubmit) return
  saving = true
  save.mutate()
}

// ------------------------------------------------------------------------ archive and restore

let archiving = $state<Category | null>(null)
let acting = $state(false)

interface ArchiveVars {
  categoryId: string
  archived: boolean
  name: string
}

const setArchived = createMutation(() => ({
  mutationFn: (vars: ArchiveVars) =>
    api.categories.archive({ workspaceId, categoryId: vars.categoryId, archived: vars.archived }),
  onSuccess: (_saved: Category, vars: ArchiveVars) => {
    toast.success(
      t(vars.archived ? 'category_archived_toast' : 'category_restored_toast', isolated({ name: vars.name })),
    )
    void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
    archiving = null
  },
  onError: (error: unknown) => toast.error(errorMessage(error, t)),
  onSettled: () => {
    acting = false
  },
}))

function confirmArchive() {
  const target = archiving
  if (!target || acting) return
  acting = true
  setArchived.mutate({ categoryId: target.id, archived: true, name: target.name })
}

function restore(category: Category) {
  if (acting) return
  acting = true
  setArchived.mutate({ categoryId: category.id, archived: false, name: category.name })
}

/**
 * Restoring takes nothing away and needs no confirmation; archiving states what happens to the
 * assets already filed under it. Hidden rather than disabled without the permission.
 */
function actionsFor(category: Category): MenuItem[] {
  const items: MenuItem[] = [
    { label: t('common.edit'), icon: 'square-pen', onSelect: () => openEdit(category) },
  ]
  if (category.archivedAt) {
    items.push({ label: t('restore'), icon: 'rotate-ccw', onSelect: () => restore(category) })
  } else {
    items.push({ type: 'separator' })
    items.push({
      label: t('common.archive'),
      icon: 'archive',
      danger: true,
      onSelect: () => (archiving = category),
    })
  }
  return items
}

const SKELETON_ROWS = [0, 1, 2, 3]
</script>

<!--
  One row, drawn the same whether it is part of the sequence or sitting in the archived group. The
  grip, the two arrows and the drag itself belong only to the sequence: an archived category is in
  no picker and no filter, so it has no position for anybody to arrange.
-->
{#snippet row(category: Category, sortable: boolean)}
  <li
    class="row"
    class:sortable
    class:shadow={isShadow(category)}
    aria-label={sortable ? category.name : undefined}
  >
    {#if sortable}
      <span class="grip" aria-hidden="true"><Icon name="grip-vertical" size={14} strokeWidth={1.8} /></span>
    {/if}
    <span class="cell">
      <span class="name">{category.name}</span>
      <!-- Only the archived state gets a badge. A "live" badge on every other row would be a column
           of the same word, and the one it would have to borrow — `status_in_stock` — describes an
           asset sitting in a cupboard, not a category. -->
      {#if category.archivedAt}<Badge tone="grey">{t('archived')}</Badge>{/if}
    </span>
    {#if sortable}
      <IconButton
        icon="chevron-up"
        size={28}
        label={t('category_move_up', isolated({ name: category.name }))}
        onclick={() => move(category, -1)}
      />
      <IconButton
        icon="chevron-down"
        size={28}
        label={t('category_move_down', isolated({ name: category.name }))}
        onclick={() => move(category, 1)}
      />
    {/if}
    {#if canManage}
      <DropdownMenu items={actionsFor(category)} align="end">
        {#snippet trigger(props)}
          <IconButton
            {...props}
            icon="ellipsis"
            size={28}
            label={t('row_actions', isolated({ name: category.name }))}
          />
        {/snippet}
      </DropdownMenu>
    {/if}
  </li>
{/snippet}

<SettingsPage title={t('settings_categories')} description={t('settings_categories_desc')}>
  {#snippet actions()}
    {#if canManage}
      <Button size="sm" icon="plus" onclick={openCreate}>{t('category_new')}</Button>
    {/if}
  {/snippet}

  <SettingsSection flush>
    <div class="bar">
      <!-- The hint earns its place only where the gesture is available and there is something to
           reorder. On a one-category workspace it would explain a thing that cannot be done. -->
      {#if canManage && live.length > 1}
        <p class="hint">{t('category_reorder_hint')}</p>
      {/if}
      <Switch bind:checked={showArchived} size="sm" label={t('show_archived')} />
    </div>

    {#if categoriesQuery.isPending}
      <div class="skeleton">
        {#each SKELETON_ROWS as skeleton (skeleton)}
          <div class="srow">
            <Skeleton height="12px" width="52%" />
            {#if canManage}<Skeleton height="12px" width="16px" />{/if}
          </div>
        {/each}
      </div>
    {:else if categoriesQuery.isError}
      <EmptyState icon="triangle-alert" title={t('categories_error')} description={t('common.error')}>
        {#snippet actions()}
          <Button variant="secondary" onclick={() => void categoriesQuery.refetch()}>
            {t('common.retry')}
          </Button>
        {/snippet}
      </EmptyState>
    {:else if everything.length === 0}
      <!--
        Reachable, and worth keeping: `onWorkspaceEnabled` seeds five categories, but it only runs
        when a workspace switches the module on — an instance upgraded with Inventory already
        enabled never ran it, and neither does a workspace whose seeding half failed.
      -->
      <EmptyState icon="tag" title={t('categories_empty')} description={t('categories_empty_desc')}>
        {#snippet actions()}
          {#if canManage}
            <Button onclick={openCreate}>{t('category_new')}</Button>
          {/if}
        {/snippet}
      </EmptyState>
    {:else if allArchived}
      <!--
        Not "No categories yet": this workspace has categories and is looking at none of them. The
        action is the one that fixes it — show the archived rows, which is where Restore lives —
        rather than a New category button that would leave the archived ones exactly as they are.
      -->
      <EmptyState
        icon="archive"
        title={t('categories_all_archived')}
        description={t('categories_all_archived_desc')}
      >
        {#snippet actions()}
          <Button variant="secondary" onclick={() => (showArchived = true)}>
            {t('show_archived')}
          </Button>
        {/snippet}
      </EmptyState>
    {:else}
      {#if canManage}
        <!--
          The drag is a pointer gesture here, and the arrows on each row are the keyboard equivalent.

          `autoAriaDisabled`, because the library speaks its own English to screen readers and this
          product promises five languages; every sentence a reader hears here is one of ours, in the
          live region below. `zoneTabIndex: -1` and `zoneItemTabIndex: -1` take the list and its rows
          out of the tab order — stops that announce nothing and do nothing, now that the library is
          neither describing them nor driving them — and `onkeydowncapture` takes the trigger keys
          away from a row focused by a click, which is the one way left into the library's own
          keyboard drag. See `keepKeyboardOnTheButtons` for why that route is off rather than fixed.
        -->
        <ul
          class="rows"
          role="list"
          aria-label={t('settings_categories')}
          aria-busy={sequence.saving}
          use:dndzone={{
            items: rows,
            type: 'inventory-categories',
            flipDurationMs: FLIP,
            dropTargetStyle: {},
            autoAriaDisabled: true,
            zoneTabIndex: -1,
            zoneItemTabIndex: -1,
          }}
          onconsider={consider}
          onfinalize={finalize}
          onkeydowncapture={keepKeyboardOnTheButtons}
        >
          {#each rows as category (category.id)}
            {@render row(category, true)}
          {/each}
        </ul>
      {:else}
        <ul class="rows" role="list" aria-label={t('settings_categories')}>
          {#each rows as category (category.id)}
            {@render row(category, false)}
          {/each}
        </ul>
      {/if}

      <!--
        Archived categories, in their own group and in their own order.

        Not part of the sequence above, because they are in no picker and no filter — there is
        nothing for a position to be a position *in*. Sorted by name rather than by the number they
        happened to leave with, which is the one ordering somebody can predict. `h2`, not `h3`: this
        section is passed no title, so the page's `h1` is the level directly above it.
      -->
      {#if showArchived && archived.length > 0}
        <h2 class="kern-sublabel group">{t('archived')}</h2>
        <ul class="rows" role="list" aria-label={t('archived')}>
          {#each archived as category (category.id)}
            {@render row(category, false)}
          {/each}
        </ul>
      {/if}
    {/if}
  </SettingsSection>
</SettingsPage>

<!-- Rendered always, and empty until there is something to say: a live region that appears at the
     same moment as its text is a region most screen readers never announce. Two of them, written
     alternately, so the same sentence twice in a row is still a change — see `announce`. -->
<p class="kern-sr-only" aria-live="polite">{announcements[0]}</p>
<p class="kern-sr-only" aria-live="polite">{announcements[1]}</p>

<Dialog
  bind:open={dialogOpen}
  size="sm"
  title={editing ? t('category_edit') : t('category_new')}
>
  <div class="form">
    <Field label={t('category')} id="inv-cat-name" required hint={t('category_name_placeholder')}>
      {#snippet children(id)}
        <Input {id} bind:value={name} maxlength={120} />
      {/snippet}
    </Field>
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (dialogOpen = false)}>{t('common.cancel')}</Button>
    <Button onclick={submit} disabled={!canSubmit} loading={saving}>{t('common.save')}</Button>
  {/snippet}
</Dialog>

<!-- States what happens to the assets already filed under it, rather than asking "Are you sure?". -->
<Dialog
  open={archiving !== null}
  size="sm"
  title={t('category_archive_title', isolated({ name: archiving?.name ?? '' }))}
  onOpenChange={(next) => {
    if (!next) archiving = null
  }}
>
  <p class="dialog-body">{t('category_archive_body')}</p>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (archiving = null)}>{t('common.cancel')}</Button>
    <Button variant="danger" onclick={confirmArchive} loading={acting}>{t('common.archive')}</Button>
  {/snippet}
</Dialog>

<style>
  .bar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 16px;
    padding: 10px 12px;
  }
  .hint {
    margin: 0;
    min-width: 0;
    /* Logical, so the switch stays at the trailing edge in Persian and Arabic too. */
    margin-inline-end: auto;
    font-size: 12px;
    line-height: 1.5;
    /* A colour rather than opacity, which fades text against the page whatever token it names. */
    color: var(--kern-ink-500);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 48px;
    padding: 4px 12px;
    border-top: 1px solid var(--kern-border-hairline);
    font-size: 13px;
    color: var(--kern-ink-600);
    background: var(--kern-surface-raised);
  }
  .row.sortable {
    cursor: grab;
  }
  .row.sortable:active {
    cursor: grabbing;
  }
  /* The placeholder the drag library keeps under the cursor, marking where the row will land.
     Hidden rather than faded: it still holds its space, so the gap opens exactly where the row is
     going, and a half-transparent copy of a row that is already on screen under the pointer reads
     as a rendering fault rather than as a target. */
  .row.shadow {
    visibility: hidden;
  }
  .grip {
    display: inline-flex;
    color: var(--kern-ink-400);
  }
  .cell {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
  }
  .name {
    font-weight: 500;
    color: var(--kern-ink-900);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    /* A value somebody typed decides its own direction: `plaintext` takes it from the value's
       first strong character, so a Latin name inside a Persian screen reads left to right and
       keeps its own trailing punctuation instead of donating it to the paragraph. */
    unicode-bidi: plaintext;
  }
  .group {
    margin: 0;
    padding: 16px 12px 6px;
    border-top: 1px solid var(--kern-border-hairline);
  }
  .skeleton {
    display: flex;
    flex-direction: column;
  }
  .srow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 18px 12px;
    border-top: 1px solid var(--kern-border-hairline);
  }
  .form {
    display: grid;
    gap: 14px;
  }
  .dialog-body {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--kern-ink-700);
  }
</style>
