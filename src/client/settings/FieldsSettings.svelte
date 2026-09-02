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
  Select,
  type SelectOption,
  SettingsPage,
  SettingsSection,
  Skeleton,
  Switch,
  session,
  Textarea,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { untrack } from 'svelte'
import { dndzone, SHADOW_ITEM_MARKER_PROPERTY_NAME } from 'svelte-dnd-action'
import { type Category, type FieldDef, FieldKey, FieldType } from '../../contract/index.js'
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
 * What this workspace records about an asset that the built-in details do not — a cost centre, a
 * supplier reference, a MAC address — and the order those questions are asked in.
 *
 * The same page as `CategoriesSettings`, on purpose: a field is the same kind of thing as a
 * category — workspace configuration everybody's assets are filed against — and the sequence, the
 * archived group and the `order_stale` recovery are copied from there line for line rather than
 * abstracted, because the two pages are going to diverge in what a row *is* and not in how a list
 * is dragged. What is new here is the dialog: a field has a key and a type that are fixed the
 * moment it exists, a scope, a required switch, and — for the two choice types — a list of choices.
 *
 * **The order is dragged, not typed**, and the drag has a keyboard equivalent on every row — see
 * `keepKeyboardOnTheButtons` for why the library's own keyboard route is switched off.
 *
 * **Nothing here deletes.** Every value an asset carries is stored under the field's key, and
 * removing the definition would leave those values unnameable on every panel. Archiving takes the
 * field off the form and out of the panel's questions while leaving every recorded value readable;
 * the same procedure restores it.
 */
const api = getInventoryApi()
const queryClient = useQueryClient()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspaceId = $derived(session.workspaces.find((w) => w.slug === workspaceSlug)?.id ?? '')

/**
 * The permission the server enforces on every write here. The page is gated on it in `module.ts`,
 * but a settings URL can be typed, and a read-only list is a better answer than a form that 403s.
 */
const canManage = $derived(session.can(INVENTORY_PERMISSIONS.fields))

let showArchived = $state(false)

/**
 * One query for every field, archived ones included, split here — for the reason the categories
 * page does it: it is the only way to tell **"no fields yet"** from **"every field is archived"**,
 * and it is the key the detail panel already holds, so arriving here from it costs no request.
 */
const fieldsQuery = createQuery(() => ({
  queryKey: inventoryKeys.fields(workspaceId, true),
  queryFn: () => api.fields.list({ workspaceId, archived: true }),
  enabled: Boolean(workspaceId),
}))
const everything = $derived<FieldDef[]>(fieldsQuery.data ?? [])

/**
 * Categories, archived ones included, for two things: the scope picker in the dialog, which offers
 * the live ones plus whichever this field is already scoped to, and the scope column on each row,
 * which has to name a category even after somebody archived it.
 */
const categoriesQuery = createQuery(() => ({
  queryKey: inventoryKeys.categories(workspaceId, true),
  queryFn: () => api.categories.list({ workspaceId, archived: true }),
  enabled: Boolean(workspaceId),
}))
const categories = $derived<Category[]>(categoriesQuery.data ?? [])
const categoryNames = $derived(new Map(categories.map((row) => [row.id, row.name])))

/**
 * What a row's scope reads as: every asset, or the category's name.
 *
 * Null while the categories are still on their way. Printing `category_none` there would call a
 * laptops-only field "Uncategorised" for the first moments of every visit, which is the opposite
 * of what it is.
 */
function scopeOf(field: FieldDef): string | null {
  if (field.categoryId === null) return t('field_scope_all')
  return categoryNames.get(field.categoryId) ?? null
}

/** `live` is the sequence; `archived` is its own group, sorted by name — see the categories page. */
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
 * The order on screen, the two snapshots behind it, and the two flags — one value, in `sequence.ts`,
 * for the reasons `CategoriesSettings` gives. `$state.raw`, because a deep-reactive proxy hands the
 * drag library a different object on every read.
 */
let sequence = $state.raw<Sequence<FieldDef>>(start<FieldDef>([]))
let announcements = $state<[string, string]>(['', ''])
let pulse = false

/** The library's types want a mutable array; nothing here ever mutates it. */
const rows = $derived(sequence.rows as FieldDef[])

/**
 * Seed the sequence from the query, and only from it. `seed` declines during a drag or a save, and
 * `untrack` keeps this effect from feeding itself — see the categories page for both.
 */
$effect(() => {
  const next = live
  sequence = untrack(() => seed(sequence, next))
})

const isShadow = (field: FieldDef) =>
  (field as unknown as Record<string, unknown>)[SHADOW_ITEM_MARKER_PROPERTY_NAME] === true

/** The reason token the server sends when the list no longer describes the workspace. */
const ORDER_STALE = 'inventory.field.order_stale'

const reorder = createMutation(() => ({
  mutationFn: (fieldIds: readonly string[]) => api.fields.reorder({ workspaceId, fieldIds: [...fieldIds] }),
  onSuccess: (written: FieldDef[]) => {
    take(saved(sequence, written))
    // The asset form renders the fields in this order, and it reads the same query.
    void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
  },
  /**
   * Say why, and — for `order_stale`, the one refusal a person can act on — re-seed from what the
   * server actually has, so the retry sends a list it can accept. A rollback alone restores the
   * list the server has just refused; the categories page explains the trap in full.
   */
  onError: async (error: unknown) => {
    toast.error(errorMessage(error, t))
    const stale = reasonOf(error) === ORDER_STALE
    sequence = refused(sequence)
    await queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
    if (!stale) return
    const fresh = queryClient.getQueryData<FieldDef[]>(inventoryKeys.fields(workspaceId, true))
    if (fresh) sequence = reseed(fresh.filter((row) => !row.archivedAt))
  },
}))

/** Adopt a transition, and do the work it leaves behind: post a list, speak a sentence, or neither. */
function take(step: Step<FieldDef>) {
  sequence = step.next
  if (step.announce) announce(step.announce.list, step.announce.id)
  if (step.save) reorder.mutate(step.save)
}

function move(field: FieldDef, delta: number) {
  take(moved(sequence, field.id, delta))
}

function consider(event: CustomEvent<{ items: FieldDef[]; info: { trigger: string } }>) {
  take(considered(sequence, event.detail.items, event.detail.info.trigger))
}

function finalize(event: CustomEvent<{ items: FieldDef[]; info: { id: string } }>) {
  take(
    finalized(
      sequence,
      event.detail.items.filter((field) => !isShadow(field)),
      event.detail.info.id,
    ),
  )
}

/**
 * The keys `svelte-dnd-action` claims on a row, held back before they ever reach it.
 *
 * This screen has one keyboard route to reordering — the two buttons on each row — and the
 * library's own is switched off rather than left as a worse duplicate of them. Capture phase on the
 * list, so the row's own listener never sees the key; a key on a button inside a row passes through.
 * The full argument is on the categories page, above the same function.
 */
const LIBRARY_DRAG_KEYS = new Set(['Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])

function keepKeyboardOnTheButtons(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  if (!target || target.parentElement !== event.currentTarget) return
  if (LIBRARY_DRAG_KEYS.has(event.key)) event.stopPropagation()
}

/**
 * What a screen reader is told after a move — where the row *is*, by its neighbour's name, never a
 * number — written into two live regions alternately so the same sentence twice is still a change.
 */
function announce(list: readonly FieldDef[], id: string) {
  const name = list.find((field) => field.id === id)?.name
  const spot = placementOf(list, id)
  if (name === undefined || spot.at === 'gone') return
  const sentence =
    spot.at === 'after'
      ? t('field_position_after', isolated({ name, other: spot.previous.name }))
      : t(spot.at === 'first' ? 'field_position_first' : 'field_position_last', isolated({ name }))
  pulse = !pulse
  announcements = pulse ? [sentence, ''] : ['', sentence]
}

// -------------------------------------------------------------------- the add / edit dialog

let editing = $state<FieldDef | null>(null)
let dialogOpen = $state(false)
let key = $state('')
let name = $state('')
let description = $state('')
let fieldType = $state<FieldType>('text')
/** The category this field is scoped to; `''` means every asset. */
let scope = $state('')
let required = $state(false)
/** One choice per line. Parsed in `options` below; the textarea is the simplest editor that works. */
let optionsText = $state('')

function openCreate() {
  editing = null
  key = ''
  name = ''
  description = ''
  fieldType = 'text'
  scope = ''
  required = false
  optionsText = ''
  dialogOpen = true
}

function openEdit(field: FieldDef) {
  editing = field
  key = field.key
  name = field.name
  description = field.description ?? ''
  fieldType = field.type
  scope = field.categoryId ?? ''
  required = field.required
  optionsText = field.options.join('\n')
  dialogOpen = true
}

/** The seven types, labelled through the catalogue — `field_type_*` is in `messages.test.ts`'s built set. */
const typeOptions = $derived<SelectOption[]>(
  FieldType.options.map((value) => ({ value, label: t(`field_type_${value}`) })),
)

/**
 * Every asset, or one live category — plus whichever this field is already scoped to, so opening
 * the dialog on a field for an archived category keeps naming it rather than silently widening the
 * field to every asset on the next save.
 */
const scopeOptions = $derived<SelectOption[]>([
  { value: '', label: t('field_scope_all') },
  ...categories
    .filter((row) => !row.archivedAt || row.id === scope)
    .map((row) => ({ value: row.id, label: row.name })),
])

const takesOptions = $derived(fieldType === 'select' || fieldType === 'multiselect')

/** Trimmed, blanks dropped, duplicates collapsed — what the server does, done first so the form agrees. */
const options = $derived([
  ...new Set(
    optionsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  ),
])

/**
 * The key, checked against the contract's own rule rather than a second copy of the pattern.
 *
 * The error appears only once somebody has typed something: an empty box is not yet wrong, and a
 * red sentence under a field nobody has touched reads as blame.
 */
const keyValid = $derived(FieldKey.safeParse(key.trim()).success)
const keyError = $derived(key.trim() && !keyValid ? t('field_key_invalid') : null)

const canSubmit = $derived(
  canManage &&
    Boolean(name.trim()) &&
    (editing !== null || keyValid) &&
    (!takesOptions || options.length > 0),
)

/**
 * Set in the same tick as the click, for the reason the categories page gives: the attribute from
 * `disabled={mutation.isPending}` reaches the button one render later than the second click.
 */
let saving = $state(false)

const save = createMutation(() => ({
  mutationFn: () => {
    const row = editing
    const values = {
      name: name.trim(),
      description: description.trim() || null,
      categoryId: scope || null,
      required,
      // Empty for a type that takes none: the server refuses a text field handed a list, and
      // a switch of type is impossible after creation, so this is always the right answer.
      options: takesOptions ? options : [],
    }
    return row
      ? api.fields.update({ workspaceId, fieldId: row.id, ...values })
      : api.fields.create({ workspaceId, key: key.trim(), type: fieldType, ...values })
  },
  onSuccess: (written: FieldDef) => {
    toast.success(
      t(editing ? 'field_updated_toast' : 'field_created_toast', isolated({ name: written.name })),
    )
    void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
    dialogOpen = false
  },
  // Translated by reason token — `inventory.field.key_taken` and the rest — rather than the server's
  // English prose; see `errors.ts`.
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

let archiving = $state<FieldDef | null>(null)
let acting = $state(false)

interface ArchiveVars {
  fieldId: string
  archived: boolean
  name: string
}

const setArchived = createMutation(() => ({
  mutationFn: (vars: ArchiveVars) =>
    api.fields.archive({ workspaceId, fieldId: vars.fieldId, archived: vars.archived }),
  onSuccess: (_written: FieldDef, vars: ArchiveVars) => {
    toast.success(
      t(vars.archived ? 'field_archived_toast' : 'field_restored_toast', isolated({ name: vars.name })),
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
  setArchived.mutate({ fieldId: target.id, archived: true, name: target.name })
}

function restore(field: FieldDef) {
  if (acting) return
  acting = true
  setArchived.mutate({ fieldId: field.id, archived: false, name: field.name })
}

/**
 * Restoring takes nothing away and needs no confirmation; archiving states what happens to the
 * values already recorded. Hidden rather than disabled without the permission.
 */
function actionsFor(field: FieldDef): MenuItem[] {
  const items: MenuItem[] = [{ label: t('common.edit'), icon: 'square-pen', onSelect: () => openEdit(field) }]
  if (field.archivedAt) {
    items.push({ label: t('restore'), icon: 'rotate-ccw', onSelect: () => restore(field) })
  } else {
    items.push({ type: 'separator' })
    items.push({
      label: t('common.archive'),
      icon: 'archive',
      danger: true,
      onSelect: () => (archiving = field),
    })
  }
  return items
}

const SKELETON_ROWS = [0, 1, 2, 3]
</script>

<!--
  One row, drawn the same whether it is part of the sequence or sitting in the archived group. The
  grip, the two arrows and the drag itself belong only to the sequence: an archived field is asked
  on no form, so it has no position for anybody to arrange.
-->
{#snippet row(field: FieldDef, sortable: boolean)}
  {@const scopeLabel = scopeOf(field)}
  <li class="row" class:sortable class:shadow={isShadow(field)} aria-label={sortable ? field.name : undefined}>
    {#if sortable}
      <span class="grip" aria-hidden="true"><Icon name="grip-vertical" size={14} strokeWidth={1.8} /></span>
    {/if}
    <span class="cell">
      <span class="line">
        <span class="name">{field.name}</span>
        <!-- The key is read character by character, like an asset tag, so it keeps its own
             direction inside a Persian or Arabic row. -->
        <code class="key">{field.key}</code>
        {#if field.required}<Badge tone="info">{t('field_required')}</Badge>{/if}
        {#if field.archivedAt}<Badge tone="grey">{t('archived')}</Badge>{/if}
      </span>
      <span class="meta">
        <span>{t(`field_type_${field.type}`)}</span>
        {#if scopeLabel}<span class="dot" aria-hidden="true">·</span><span class="scope">{scopeLabel}</span>{/if}
      </span>
    </span>
    {#if sortable}
      <IconButton
        icon="chevron-up"
        size={28}
        label={t('field_move_up', isolated({ name: field.name }))}
        onclick={() => move(field, -1)}
      />
      <IconButton
        icon="chevron-down"
        size={28}
        label={t('field_move_down', isolated({ name: field.name }))}
        onclick={() => move(field, 1)}
      />
    {/if}
    {#if canManage}
      <DropdownMenu items={actionsFor(field)} align="end">
        {#snippet trigger(props)}
          <IconButton {...props} icon="ellipsis" size={28} label={t('row_actions', isolated({ name: field.name }))} />
        {/snippet}
      </DropdownMenu>
    {/if}
  </li>
{/snippet}

<SettingsPage title={t('settings_fields')} description={t('settings_fields_desc')}>
  {#snippet actions()}
    {#if canManage}
      <Button size="sm" icon="plus" onclick={openCreate}>{t('field_new')}</Button>
    {/if}
  {/snippet}

  <SettingsSection flush>
    <div class="bar">
      {#if canManage && live.length > 1}
        <p class="hint">{t('field_reorder_hint')}</p>
      {/if}
      <Switch bind:checked={showArchived} size="sm" label={t('show_archived')} />
    </div>

    {#if fieldsQuery.isPending}
      <div class="skeleton">
        {#each SKELETON_ROWS as skeleton (skeleton)}
          <div class="srow">
            <Skeleton height="12px" width="52%" />
            {#if canManage}<Skeleton height="12px" width="16px" />{/if}
          </div>
        {/each}
      </div>
    {:else if fieldsQuery.isError}
      <EmptyState icon="triangle-alert" title={t('fields_error')} description={t('common.error')}>
        {#snippet actions()}
          <Button variant="secondary" onclick={() => void fieldsQuery.refetch()}>
            {t('common.retry')}
          </Button>
        {/snippet}
      </EmptyState>
    {:else if everything.length === 0}
      <EmptyState icon="list-checks" title={t('fields_empty')} description={t('fields_empty_desc')}>
        {#snippet actions()}
          {#if canManage}
            <Button onclick={openCreate}>{t('field_new')}</Button>
          {/if}
        {/snippet}
      </EmptyState>
    {:else if allArchived}
      <EmptyState icon="archive" title={t('fields_all_archived')} description={t('fields_all_archived_desc')}>
        {#snippet actions()}
          <Button variant="secondary" onclick={() => (showArchived = true)}>
            {t('show_archived')}
          </Button>
        {/snippet}
      </EmptyState>
    {:else}
      {#if canManage}
        <!-- The drag is a pointer gesture; the arrows on each row are the keyboard equivalent. The
             library is neither describing the rows nor driving them — see the categories page. -->
        <ul
          class="rows"
          role="list"
          aria-label={t('settings_fields')}
          aria-busy={sequence.saving}
          use:dndzone={{
            items: rows,
            type: 'inventory-fields',
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
          {#each rows as field (field.id)}
            {@render row(field, true)}
          {/each}
        </ul>
      {:else}
        <ul class="rows" role="list" aria-label={t('settings_fields')}>
          {#each rows as field (field.id)}
            {@render row(field, false)}
          {/each}
        </ul>
      {/if}

      {#if showArchived && archived.length > 0}
        <h2 class="kern-sublabel group">{t('archived')}</h2>
        <ul class="rows" role="list" aria-label={t('archived')}>
          {#each archived as field (field.id)}
            {@render row(field, false)}
          {/each}
        </ul>
      {/if}
    {/if}
  </SettingsSection>
</SettingsPage>

<!-- Two live regions, written alternately, so the same sentence twice is still a change. -->
<p class="kern-sr-only" aria-live="polite">{announcements[0]}</p>
<p class="kern-sr-only" aria-live="polite">{announcements[1]}</p>

<Dialog bind:open={dialogOpen} size="sm" title={editing ? t('field_edit') : t('field_new')}>
  <div class="form">
    <Field label={t('field_name')} id="inv-field-name" required hint={t('field_name_placeholder')}>
      {#snippet children(id)}
        <Input {id} bind:value={name} maxlength={80} />
      {/snippet}
    </Field>

    <!-- The key and the type are fixed at creation: a value already written under them cannot be
         reinterpreted. On edit they are shown as they are, and not as controls that would refuse. -->
    {#if editing}
      <dl class="fixed">
        <dt>{t('field_key')}</dt>
        <dd><code class="key">{editing.key}</code></dd>
        <dt>{t('field_type')}</dt>
        <dd>{t(`field_type_${editing.type}`)}</dd>
      </dl>
    {:else}
      <Field label={t('field_key')} id="inv-field-key" required hint={t('field_key_hint')}>
        {#snippet children(id)}
          <Input {id} bind:value={key} mono dir="ltr" autocapitalize="off" spellcheck={false} maxlength={40} error={keyError} />
        {/snippet}
      </Field>
      <Field label={t('field_type')} id="inv-field-type" hint={t('field_type_hint')}>
        {#snippet children(id)}
          <Select {id} bind:value={fieldType} options={typeOptions} ariaLabel={t('field_type')} />
        {/snippet}
      </Field>
    {/if}

    <Field label={t('field_description')} id="inv-field-desc" hint={t('field_description_hint')}>
      {#snippet children(id)}
        <Textarea {id} bind:value={description} rows={2} maxlength={500} />
      {/snippet}
    </Field>

    <Field label={t('field_scope')} id="inv-field-scope">
      {#snippet children(id)}
        <Select {id} bind:value={scope} options={scopeOptions} ariaLabel={t('field_scope')} />
      {/snippet}
    </Field>

    {#if takesOptions}
      <Field label={t('field_options')} id="inv-field-options" required hint={t('field_options_hint')}>
        {#snippet children(id)}
          <Textarea {id} bind:value={optionsText} rows={4} />
        {/snippet}
      </Field>
      <!-- Said here, beside the list, rather than discovered on a panel afterwards: the value an
           asset holds is the word itself, and this dialog cannot reach into the assets that chose
           the old one. -->
      <p class="note">{t('field_options_rename_note')}</p>
    {/if}

    <Switch bind:checked={required} label={t('field_required')} description={t('field_required_desc')} />
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (dialogOpen = false)}>{t('common.cancel')}</Button>
    <Button onclick={submit} disabled={!canSubmit} loading={saving}>{t('common.save')}</Button>
  {/snippet}
</Dialog>

<!-- States what survives — every recorded value — rather than asking "Are you sure?". -->
<Dialog
  open={archiving !== null}
  size="sm"
  title={t('field_archive_title', isolated({ name: archiving?.name ?? '' }))}
  onOpenChange={(next) => {
    if (!next) archiving = null
  }}
>
  <p class="dialog-body">{t('field_archive_body')}</p>
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
    min-height: 56px;
    padding: 8px 12px;
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
  /* The drag library's placeholder: hidden rather than faded, so the gap opens where the row is
     going without a half-transparent twin of it under the pointer. */
  .row.shadow {
    visibility: hidden;
  }
  .grip {
    display: inline-flex;
    color: var(--kern-ink-400);
  }
  .cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 8px;
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
  .key {
    font-family: var(--kern-font-mono);
    font-size: 11.5px;
    color: var(--kern-ink-500);
    /* A key is read character by character, like an asset tag, so it stays left-to-right inside
       a Persian or Arabic row and the bidi algorithm does not reorder its characters. */
    direction: ltr;
    unicode-bidi: isolate;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--kern-ink-500);
    min-width: 0;
  }
  .scope {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    padding: 22px 12px;
    border-top: 1px solid var(--kern-border-hairline);
  }
  .form {
    display: grid;
    gap: 14px;
  }
  .fixed {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 4px 14px;
    margin: 0;
    font-size: 13px;
  }
  .fixed dt {
    color: var(--kern-ink-500);
  }
  .fixed dd {
    margin: 0;
    color: var(--kern-ink-900);
  }
  .note {
    margin: -6px 0 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--kern-ink-500);
  }
  .dialog-body {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--kern-ink-700);
  }
</style>
