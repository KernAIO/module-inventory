import type { core } from '@kernhq/contracts'
import { KernError, type Kernel, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, asc, eq } from 'drizzle-orm'
import type { Attachment as AttachmentModel } from '../../contract/models.js'
import { assets, attachments, repairs } from '../schema.js'
import type { HistoryInput, NotifyService } from './notify.js'

type Row = typeof attachments.$inferSelect

/** What this module copies out of core's file record, and all it copies. */
export interface FileFacts {
  id: string
  name: string
  mimeType: string | null
  size: number | null
}

/** The wire shape: drizzle gives Date objects for timestamps, the contract promises ISO strings. */
export function toAttachment(row: Row): AttachmentModel {
  return {
    id: row.id,
    workspaceId: row.workspaceId as AttachmentModel['workspaceId'],
    assetId: row.assetId,
    repairId: row.repairId,
    fileId: row.fileId,
    name: row.name,
    mimeType: row.mimeType,
    size: row.size,
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * Files kept against an asset — receipts, warranties, manuals, a repair invoice.
 *
 * **A module does not upload, and this class is what that sentence means in code.** The browser
 * sends the bytes to core's file service and is handed an id; this records that the asset has that
 * file, with the name and size copied at attach time so a list can be drawn without asking core once
 * per row. Nothing here streams, signs, stores or deletes a byte — `remove` detaches, because the
 * same file may be attached elsewhere and a module has no standing to destroy another module's row.
 *
 * The copied name is a snapshot on purpose: renaming a file in core does not rename it here, which
 * is the same trade every module makes when it copies a label rather than joining across a schema
 * boundary. What it buys is a files list that is one query rather than one query plus a call per row.
 */
export class AttachmentService {
  constructor(
    private readonly kernel: Kernel,
    private readonly notify: NotifyService,
  ) {}

  /**
   * What core knows about these files — **called before the transaction opens, never inside one.**
   *
   * `kernel.call` is a request to another service over the broker, and awaiting one while holding a
   * pooled connection is the failure `AssetService.codeFormat` documents: the pool starves under
   * concurrent writes, and an attach fails outright whenever core is briefly away. So the router
   * gathers the facts first and hands them to `add`, which does nothing but write.
   *
   * Two checks, and the first one is the one that matters: **a file has to belong to this
   * workspace.** The id arrives in the request, so without this a member of one workspace could
   * attach another workspace's file and read its name and size back out of the list — the module
   * boundary does not help here, because core answers this module as a service.
   */
  async describe(workspaceId: string, fileIds: readonly string[]): Promise<FileFacts[]> {
    const unique = [...new Set(fileIds)]
    const found = await Promise.all(
      unique.map(async (id) => {
        const file = await this.kernel.call<core.FileObject | null>('core.files.get', { id })
        if (!file || file.workspaceId !== workspaceId)
          throw KernError.badRequest('That file is not one this workspace can attach.')
        if (file.status !== 'ready') throw KernError.badRequest('That file has not finished uploading yet.')
        return {
          id: file.id,
          name: file.name,
          mimeType: file.mimeType || null,
          size: typeof file.size === 'number' ? file.size : null,
        }
      }),
    )
    return found
  }

  /**
   * Every file on one asset, its repairs' included, oldest first.
   *
   * Not paged and not filtered by repair: one asset's files are bounded by how much paperwork one
   * item collects, and the panel groups them in the browser. That is the one case where filtering
   * client-side is right — the list is entirely loaded — and it is the opposite of what a paged
   * asset list may do.
   */
  async list(tx: Tx, workspaceId: string, assetId: string): Promise<AttachmentModel[]> {
    const rows = await tx
      .select()
      .from(attachments)
      .where(and(eq(attachments.workspaceId, workspaceId), eq(attachments.assetId, assetId)))
      .orderBy(asc(attachments.createdAt), asc(attachments.id))
    return rows.map(toAttachment)
  }

  /**
   * Record that this asset has these files.
   *
   * `onConflictDoNothing` on `(asset_id, file_id)`: attaching the same file to the same asset twice
   * is not an error worth refusing — somebody pressed the button twice, or dropped the same receipt
   * in again — and the second attempt simply adds nothing. The rows that *were* inserted come back,
   * so the caller announces exactly what changed.
   *
   * An archived asset is deliberately allowed: finding the receipt for something you retired last
   * month is a reason to file it, not a reason to be refused.
   */
  async add(
    tx: Tx,
    workspaceId: string,
    actorId: string | null,
    assetId: string,
    repairId: string | null,
    files: readonly FileFacts[],
  ): Promise<{ rows: Row[]; activities: HistoryInput[] }> {
    await this.requireAsset(tx, workspaceId, assetId)
    if (repairId) await this.requireRepair(tx, workspaceId, assetId, repairId)
    if (!files.length) return { rows: [], activities: [] }

    const inserted = await tx
      .insert(attachments)
      .values(
        files.map((file) => ({
          id: uuidv7(),
          workspaceId,
          assetId,
          repairId,
          fileId: file.id,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          uploadedBy: actorId,
        })),
      )
      .onConflictDoNothing({ target: [attachments.assetId, attachments.fileId] })
      .returning()

    /**
     * One timeline entry per file, rather than one saying "3 files".
     *
     * A timeline is read to find out what happened to a thing, and "attached the purchase receipt"
     * answers that where "attached 3 files" sends the reader looking. Attaching several at once is
     * rare enough that the extra rows cost nothing.
     */
    const activities: HistoryInput[] = inserted.map((row) => ({
      workspaceId,
      assetId,
      actorId,
      action: 'attachment_added',
      data: {
        attachmentId: row.id,
        name: row.name,
        ...(row.repairId ? { repairId: row.repairId } : {}),
      },
    }))
    for (const activity of activities) await this.notify.history(tx, activity)
    return { rows: inserted, activities }
  }

  /** Detach one file. Core's copy of it is untouched — see the class docblock. */
  async remove(
    tx: Tx,
    workspaceId: string,
    actorId: string | null,
    attachmentId: string,
  ): Promise<{ row: Row; activity: HistoryInput }> {
    const [row] = await tx
      .select()
      .from(attachments)
      .where(and(eq(attachments.workspaceId, workspaceId), eq(attachments.id, attachmentId)))
    if (!row) throw KernError.notFound('Attachment')

    // Filtered by workspace as well as by id, like every other write in this module: `core`
    // connects as a superuser with RLS bypassed, so the predicate in the statement is the only
    // barrier there is, and a barrier that holds only because of what an earlier statement happened
    // to do is not one.
    await tx
      .delete(attachments)
      .where(and(eq(attachments.workspaceId, workspaceId), eq(attachments.id, attachmentId)))

    const activity: HistoryInput = {
      workspaceId,
      assetId: row.assetId,
      actorId,
      action: 'attachment_removed',
      data: { attachmentId: row.id, name: row.name },
    }
    await this.notify.history(tx, activity)
    return { row, activity }
  }

  private async requireAsset(tx: Tx, workspaceId: string, assetId: string): Promise<void> {
    const [row] = await tx
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.workspaceId, workspaceId), eq(assets.id, assetId)))
    if (!row) throw KernError.notFound('Asset')
  }

  /** A repair the file is filed under has to be one of *this* asset's, not merely one that exists. */
  private async requireRepair(tx: Tx, workspaceId: string, assetId: string, repairId: string): Promise<void> {
    const [row] = await tx
      .select({ id: repairs.id })
      .from(repairs)
      .where(
        and(eq(repairs.workspaceId, workspaceId), eq(repairs.id, repairId), eq(repairs.assetId, assetId)),
      )
    if (!row) throw KernError.notFound('Repair')
  }
}
