<script lang="ts">
import {
  Button,
  coreApi,
  Dialog,
  EmptyState,
  formatBytes,
  Icon,
  IconButton,
  Skeleton,
  toast,
  uploadFile,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import type { Attachment } from '../../contract/index.js'
import { getInventoryApi } from '../api-instance.js'
import { isolated } from '../bidi.js'
import type { CoreApi } from '../core-api.js'
import { errorMessage } from '../errors.js'
import { t } from '../i18n.js'
import { inventoryKeys } from '../query.js'

/**
 * The files kept against an asset, or against one of its repairs.
 *
 * **This module does not upload.** The browser sends the bytes to core through `uploadFile` and is
 * handed an id; `attachments.add` then records that the asset has that file. Reading one back is a
 * URL core signs for the person asking — which is why a file another workspace owns cannot be read
 * here even though this module's server can see its name.
 *
 * One component, mounted twice: with `repairId={null}` for the asset's own paperwork, and inside a
 * repair with that repair's id. Both read one query — `attachments.list` returns every file on the
 * asset — and filter it here. That is the one case where filtering in the browser is right: the
 * list is bounded by how much paperwork one item collects and is entirely loaded, unlike a paged
 * asset list, where the same shortcut returns twenty rows and shows eleven.
 */
interface Props {
  workspaceId: string
  assetId: string
  /** Null for the asset's own files; a repair id for that repair's paperwork. */
  repairId?: string | null
  /** `inventory.asset.manage` — whether uploading and removing are offered at all. */
  canManage: boolean
  /** Inside a repair card: no empty state and no error card, because it is a detail of a detail. */
  compact?: boolean
}
const { workspaceId, assetId, repairId = null, canManage, compact = false }: Props = $props()

const api = getInventoryApi()
const core = coreApi<CoreApi>()
const queryClient = useQueryClient()

const filesQuery = createQuery(() => ({
  queryKey: inventoryKeys.assetAttachments(workspaceId, assetId),
  queryFn: () => api.attachments.list({ workspaceId, assetId }),
  enabled: Boolean(workspaceId && assetId),
}))

const rows = $derived<readonly Attachment[]>(
  (filesQuery.data ?? []).filter((row: Attachment) => (row.repairId ?? null) === repairId),
)

/**
 * A signed URL per file, resolved once and kept for as long as the panel is open.
 *
 * Core signs these with a lifetime measured in minutes, so they are deliberately not stored in the
 * query cache — a link that worked when the panel opened and 404s an hour later is worse than one
 * fetched again. `{#await}` on a memoised promise is what `module-chat` does with the same files.
 */
const urls = new Map<string, Promise<string>>()
function urlFor(fileId: string): Promise<string> {
  const cached = urls.get(fileId)
  if (cached) return cached
  const pending = core.files.downloadUrl({ id: fileId, disposition: 'attachment' }).then((res) => res.url)
  urls.set(fileId, pending)
  return pending
}

// ------------------------------------------------------------------------------- uploading

let input = $state<HTMLInputElement | null>(null)
/**
 * A plain flag set in the same tick as the click, not `mutation.isPending`.
 *
 * The attribute reaches the button one render later and two quick clicks are one render apart, so a
 * double-click uploads the same file twice — the second insert is dropped by the unique index, but
 * the bytes have already gone to storage.
 */
let busy = $state(false)

const attach = createMutation(() => ({
  mutationFn: (fileIds: string[]) => api.attachments.add({ workspaceId, assetId, fileIds, repairId }),
  onSuccess: (added: Attachment[]) => {
    if (added.length) toast.success(t('file_added_toast', { n: added.length }))
    void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
  },
  // Translated rather than the server's English prose: see `errors.ts`.
  onError: (error: unknown) => toast.error(errorMessage(error, t)),
  onSettled: () => {
    busy = false
  },
}))

/** Uploads first, then attaches: an attachment points at a file that already exists. */
async function upload(list: FileList | null) {
  if (!list?.length || busy) return
  busy = true
  const ids: string[] = []
  for (const file of Array.from(list)) {
    try {
      const uploaded = await uploadFile({
        workspaceId,
        file,
        name: file.name,
        mimeType: file.type || undefined,
        // Core keeps the owning object, so a file uploaded here is not an orphan if this module
        // then fails to record it.
        attachedTo: { module: 'inventory', type: 'asset', id: assetId },
      })
      ids.push(uploaded.id)
    } catch {
      // Named, not "an upload failed": with several files the reader has to know which one.
      toast.error(t('file_upload_failed', isolated({ name: file.name })))
    }
  }
  if (ids.length) attach.mutate(ids)
  else busy = false
}

// -------------------------------------------------------------------------------- removing

let removing = $state<Attachment | null>(null)
let removingBusy = $state(false)

const detach = createMutation(() => ({
  mutationFn: (attachmentId: string) => api.attachments.remove({ workspaceId, attachmentId }),
  onSuccess: () => {
    toast.success(t('file_removed_toast', isolated({ name: removing?.name ?? '' })))
    void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
    removing = null
  },
  // Translated rather than the server's English prose: see `errors.ts`.
  onError: (error: unknown) => toast.error(errorMessage(error, t)),
  onSettled: () => {
    removingBusy = false
  },
}))

function confirmRemove() {
  const target = removing
  if (!target || removingBusy) return
  removingBusy = true
  detach.mutate(target.id)
}

/** A picture reads as a picture, a receipt as a receipt; anything else is just a file. */
function iconFor(mimeType: string | null): string {
  if (mimeType?.startsWith('image/')) return 'image'
  if (mimeType === 'application/pdf') return 'receipt'
  return 'file-text'
}
</script>

<div class="files" class:compact>
  {#if canManage}
    <input
      bind:this={input}
      type="file"
      multiple
      hidden
      onchange={(e) => {
        void upload(e.currentTarget.files)
        // Cleared so choosing the same file twice in a row still fires `change`.
        e.currentTarget.value = ''
      }}
    />
  {/if}

  {#if filesQuery.isPending}
    <Skeleton height="34px" radius="8px" />
  {:else if filesQuery.isError && !compact}
    <EmptyState bare compact icon="triangle-alert" title={t('files_error')}>
      {#snippet actions()}
        <Button size="sm" variant="secondary" onclick={() => void filesQuery.refetch()}>
          {t('common.retry')}
        </Button>
      {/snippet}
    </EmptyState>
  {:else if rows.length === 0 && !compact}
    <EmptyState bare compact icon="paperclip" title={t('files_empty')} description={t('files_empty_desc')} />
  {:else if rows.length}
    <ul class="rows">
      {#each rows as row (row.id)}
        <li class="row">
          <Icon name={iconFor(row.mimeType)} size={14} strokeWidth={1.7} />
          {#await urlFor(row.fileId)}
            <span class="name" title={row.name}>{row.name}</span>
          {:then url}
            <a
              class="name"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              title={row.name}
              aria-label={t('file_download', isolated({ name: row.name }))}
            >
              {row.name}
            </a>
          {:catch}
            <!-- The row still says what it is: a file whose URL could not be signed is not a file
                 that has gone away. -->
            <span class="name" title={row.name}>{row.name}</span>
          {/await}
          {#if row.size !== null}<span class="size">{formatBytes(row.size)}</span>{/if}
          {#if canManage}
            <IconButton
              icon="x"
              size={26}
              label={t('file_remove', isolated({ name: row.name }))}
              onclick={() => (removing = row)}
            />
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if canManage}
    <div class="add">
      <Button size="sm" variant="secondary" icon="upload" loading={busy} onclick={() => input?.click()}>
        {t('file_add')}
      </Button>
    </div>
  {/if}
</div>

<!-- States what happens and to what, rather than asking "Are you sure?" — and the sentence's whole
     job is to say that the file itself survives, because this module never owned it. -->
<Dialog
  open={removing !== null}
  size="sm"
  title={t('file_remove_title', isolated({ name: removing?.name ?? '' }))}
  onOpenChange={(next) => {
    if (!next) removing = null
  }}
>
  <p class="dialog-body">{t('file_remove_body')}</p>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (removing = null)}>{t('common.cancel')}</Button>
    <Button variant="danger" onclick={confirmRemove} loading={removingBusy}>
      {t('common.remove')}
    </Button>
  {/snippet}
</Dialog>

<style>
  .files {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .compact {
    gap: 6px;
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: grid;
    grid-template-columns: 14px minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    color: var(--kern-ink-700);
    /* Rhythm between the rows. It is *not* what makes the download link a legal target — the
       comment here used to claim a negative margin that was not in the file, and padding on the
       row would not have grown the anchor's hit area anyway: `align-items: center` sizes a grid
       item to its own content. The link carries that itself, below. */
    padding-block: 3px;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--kern-ink-900);
    /* A value somebody typed decides its own direction: `plaintext` takes it from the value's
       first strong character, so a Latin name inside a Persian screen reads left to right and
       keeps its own trailing punctuation instead of donating it to the paragraph. */
    unicode-bidi: plaintext;
  }
  a.name {
    text-decoration: none;
    border-radius: var(--kern-r-sm);
    /* WCAG 2.5.8 wants 24px, and a line of 12.5px text is about 18 — with the remove button 26px
       away, the spacing exception does not save it. The padding grows the hit area and the equal
       negative margin gives the space back, so the margin box, and therefore the row, is exactly
       where it was. Same shape as `.name` on the assets table. */
    padding-block: 4px;
    margin-block: -4px;
  }
  a.name:hover {
    text-decoration: underline;
  }
  .size {
    /* Muted with a colour, never opacity: a faded row at 0.5 is unreadable whatever its token. */
    color: var(--kern-ink-500);
    font-variant-numeric: tabular-nums;
    /* A size is a Latin number with a Latin unit; it stays left-to-right inside an Arabic panel. */
    direction: ltr;
    unicode-bidi: isolate;
  }
  .add {
    display: flex;
  }
  .dialog-body {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--kern-ink-700);
  }
</style>
