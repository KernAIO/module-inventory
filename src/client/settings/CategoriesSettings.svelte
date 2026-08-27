<script lang="ts">
import {
  Badge,
  Button,
  Dialog,
  DropdownMenu,
  EmptyState,
  Field,
  IconButton,
  Input,
  type MenuItem,
  navigation,
  SettingsPage,
  SettingsSection,
  Skeleton,
  Switch,
  session,
  Table,
  TableCell,
  TableHeader,
  TableRow,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import type { Category } from '../../contract/index.js'
import { getInventoryApi } from '../api-instance.js'
import { isolated } from '../bidi.js'
import { errorMessage } from '../errors.js'
import { t } from '../i18n.js'
import { INVENTORY_PERMISSIONS } from '../permissions.js'
import { inventoryKeys } from '../query.js'

/**
 * How a workspace groups what it owns.
 *
 * `assets.list` has taken a `categoryId` filter since the module existed and nothing could create a
 * category, so the filter had exactly one possible answer — this page is the other half of it.
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
 * One query for every category, archived ones included, filtered here.
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
const categories = $derived(showArchived ? everything : everything.filter((row) => !row.archivedAt))
/** Rows exist, and the switch is hiding all of them. A different sentence from having none. */
const allArchived = $derived(everything.length > 0 && categories.length === 0)

// ------------------------------------------------------------------ the add / rename dialog

let editing = $state<Category | null>(null)
let dialogOpen = $state(false)
let name = $state('')
let orderText = $state('')

function openCreate() {
  editing = null
  name = ''
  orderText = '0'
  dialogOpen = true
}

function openEdit(category: Category) {
  editing = category
  name = category.name
  orderText = String(category.order)
  dialogOpen = true
}

/**
 * A Persian keyboard produces ۱۲۳ and an Arabic one ١٢٣, and `Number` reads neither — so somebody
 * typing the digits of their own language would be told their input is not a whole number.
 */
const toLatinDigits = (value: string) =>
  value
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))

const order = $derived.by(() => {
  const digits = toLatinDigits(orderText.trim())
  return /^\d{1,4}$/.test(digits) ? Number(digits) : Number.NaN
})
/**
 * A hint and an error are two different sentences, and this field passed the hint as both.
 *
 * `hint` explains how positions sort — "Lower comes first. Categories sharing a position fall back
 * to their names." — and typing `x` restated exactly that, in red, under `aria-invalid`. It told
 * somebody nothing about what was wrong with what they had typed, and it made the field's ordinary
 * hint look like a failure the first time they read it. The error says what this box will accept.
 */
const orderError = $derived(Number.isNaN(order) ? t('category_order_invalid') : null)
const canSubmit = $derived(canManage && Boolean(name.trim()) && !Number.isNaN(order))

/** Set in the same tick as the click: `disabled={mutation.isPending}` is one render too late. */
let saving = $state(false)

const save = createMutation(() => ({
  mutationFn: () => {
    const row = editing
    const values = { name: name.trim(), order }
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

const COLUMNS = $derived(canManage ? 'minmax(0, 1fr) 96px 44px' : 'minmax(0, 1fr) 96px')
const SKELETON_ROWS = [0, 1, 2, 3]
</script>

<SettingsPage title={t('settings_categories')} description={t('settings_categories_desc')}>
  {#snippet actions()}
    {#if canManage}
      <Button size="sm" icon="plus" onclick={openCreate}>{t('category_new')}</Button>
    {/if}
  {/snippet}

  <SettingsSection flush>
    <div class="bar">
      <Switch bind:checked={showArchived} size="sm" label={t('show_archived')} />
    </div>

    {#if categoriesQuery.isPending}
      <div class="skeleton">
        {#each SKELETON_ROWS as row (row)}
          <div class="srow" style:grid-template-columns={COLUMNS}>
            <Skeleton height="12px" width="52%" />
            <Skeleton height="12px" width="30%" />
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
    {:else if categories.length === 0}
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
    {:else}
      <Table columns={COLUMNS} ariaLabel={t('settings_categories')}>
        <TableHeader>
          <TableCell header>{t('category')}</TableCell>
          <TableCell header>{t('category_order')}</TableCell>
          {#if canManage}<TableCell header end></TableCell>{/if}
        </TableHeader>
        {#each categories as category (category.id)}
          <TableRow>
            <TableCell>
              <span class="cell">
                <span class="name">{category.name}</span>
                <!-- Only the archived state gets a badge. A "live" badge on every other row would
                     be a column of the same word, and the one it would have to borrow —
                     `status_in_stock` — describes an asset sitting in a cupboard, not a category. -->
                {#if category.archivedAt}<Badge tone="grey">{t('archived')}</Badge>{/if}
              </span>
            </TableCell>
            <TableCell><span class="muted">{category.order}</span></TableCell>
            {#if canManage}
              <TableCell end>
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
              </TableCell>
            {/if}
          </TableRow>
        {/each}
      </Table>
    {/if}
  </SettingsSection>
</SettingsPage>

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
    <Field label={t('category_order')} id="inv-cat-order" hint={t('category_order_hint')}>
      {#snippet children(id)}
        <div class="narrow">
          <Input {id} bind:value={orderText} inputmode="numeric" maxlength={4} mono error={orderError} />
        </div>
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
    justify-content: flex-end;
    padding: 10px 12px;
  }
  .cell {
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
  .muted {
    /* A colour rather than opacity, which fades text against the page whatever token it names. */
    color: var(--kern-ink-500);
    font-variant-numeric: tabular-nums;
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
    padding: 14px 12px;
    border-bottom: 1px solid var(--kern-border-hairline);
  }
  .form {
    display: grid;
    gap: 14px;
  }
  .narrow {
    max-inline-size: 140px;
  }
  .dialog-body {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--kern-ink-700);
  }
</style>
