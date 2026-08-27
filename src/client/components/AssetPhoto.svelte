<script lang="ts">
import { Button, coreApi, Skeleton, toast, uploadFile } from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import type { Asset } from '../../contract/index.js'
import { getInventoryApi } from '../api-instance.js'
import { isolated } from '../bidi.js'
import type { CoreApi } from '../core-api.js'
import { errorMessage } from '../errors.js'
import { t } from '../i18n.js'
import { inventoryKeys } from '../query.js'

/**
 * The asset's photo.
 *
 * `assets.photoFileId` has been a field of every asset since the module existed, settable through
 * `create` and `update` and by **nothing on screen** — an API that could store a photo and an
 * interface that could not show one. This is that half.
 *
 * It sits in **Details**, not in Files, and that is a decision: the photo is a field of the asset,
 * so it belongs with the asset's other fields. Putting it in the Files tab would hide it from any
 * workspace that switches the `attachments` capability off, and the photo has nothing to do with
 * that feature — it is `core`.
 *
 * The bytes go to core through `uploadFile`, exactly as an attachment's do; this module stores the
 * id it is handed and asks core to sign a URL to read it back. `thumbnail: true`, because a
 * full-size photograph in a 440px panel is a megabyte nobody looks at.
 */
interface Props {
  workspaceId: string
  asset: Asset
  /** `inventory.asset.manage`. Without it the photo is shown and cannot be changed. */
  canManage: boolean
}
const { workspaceId, asset, canManage }: Props = $props()

const api = getInventoryApi()
const core = coreApi<CoreApi>()
const queryClient = useQueryClient()

const photoQuery = createQuery(() => ({
  // Keyed by the file rather than by the asset: replacing the photo changes the id, so the old
  // signed URL is never served for the new photo.
  queryKey: ['inventory', 'photo', asset.photoFileId ?? ''],
  queryFn: () =>
    core.files.downloadUrl({ id: asset.photoFileId as string, disposition: 'inline', thumbnail: true }),
  enabled: Boolean(asset.photoFileId),
  // Core signs these with a lifetime measured in minutes, so a panel left open all afternoon asks
  // again rather than rendering a broken image.
  staleTime: 4 * 60_000,
}))

/**
 * A plain flag set in the same tick as the click, not `mutation.isPending`.
 *
 * The attribute reaches the button one render later and two quick clicks are one render apart.
 */
let busy = $state(false)
let input = $state<HTMLInputElement | null>(null)

const save = createMutation(() => ({
  mutationFn: (photoFileId: string | null) =>
    api.assets.update({ workspaceId, assetId: asset.id, photoFileId }),
  onSuccess: (_saved: Asset, photoFileId: string | null) => {
    toast.success(photoFileId ? t('photo_saved_toast') : t('photo_removed_toast'))
    void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
  },
  // Translated rather than the server's English prose: see `errors.ts`.
  onError: (error: unknown) => toast.error(errorMessage(error, t)),
  onSettled: () => {
    busy = false
  },
}))

async function choose(list: FileList | null) {
  const file = list?.[0]
  if (!file || busy) return
  busy = true
  try {
    const uploaded = await uploadFile({
      workspaceId,
      file,
      name: file.name,
      mimeType: file.type || undefined,
      attachedTo: { module: 'inventory', type: 'asset', id: asset.id },
    })
    save.mutate(uploaded.id)
  } catch {
    toast.error(t('file_upload_failed', isolated({ name: file.name })))
    busy = false
  }
}

/**
 * No confirmation, deliberately.
 *
 * Nothing is destroyed: the file stays in core's storage exactly where it was, and this clears one
 * uuid on one row. A dialog asking whether you are sure about a thumbnail is a dialog people learn
 * to dismiss without reading, which is what makes the ones that matter stop working.
 */
function remove() {
  if (busy) return
  busy = true
  save.mutate(null)
}
</script>

<div class="photo">
  {#if canManage}
    <input
      bind:this={input}
      type="file"
      accept="image/*"
      hidden
      onchange={(e) => {
        void choose(e.currentTarget.files)
        e.currentTarget.value = ''
      }}
    />
  {/if}

  {#if asset.photoFileId}
    {#if photoQuery.isPending}
      <Skeleton height="120px" radius="10px" />
    {:else if photoQuery.isError}
      <!-- The field is set and the URL could not be signed. Saying so beats a broken image icon. -->
      <p class="none">{t('files_error')}</p>
    {:else}
      <img src={photoQuery.data?.url} alt={t('photo_alt', isolated({ name: asset.name }))} />
    {/if}
  {:else}
    <p class="none">{t('photo_none')}</p>
  {/if}

  {#if canManage}
    <div class="acts">
      <Button size="sm" variant="secondary" icon="image" loading={busy} onclick={() => input?.click()}>
        {asset.photoFileId ? t('photo_replace') : t('photo_set')}
      </Button>
      {#if asset.photoFileId}
        <Button size="sm" variant="ghost" onclick={remove}>{t('photo_remove')}</Button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .photo {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  img {
    display: block;
    inline-size: 100%;
    max-block-size: 200px;
    object-fit: cover;
    border-radius: var(--kern-r-lg);
    border: 1px solid var(--kern-border-hairline);
    /* Behind a photo with transparency, and while one loads. Not `--kern-surface-raised`: a `Sheet`
       is already that colour, so it would be no ground at all. */
    background: var(--kern-surface-chip);
  }
  .none {
    margin: 0;
    padding: 18px 0;
    text-align: center;
    font-size: 12.5px;
    /* Muted with a colour, never opacity: a faded sentence is unreadable whatever its token. */
    color: var(--kern-ink-500);
    border: 1px dashed var(--kern-border);
    border-radius: var(--kern-r-lg);
  }
  .acts {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
</style>
