import { getHost } from '@kernhq/ui'
import { createInventoryClient, type InventoryApi } from './api.js'
import { t } from './i18n.js'
import { createMockInventoryApi, type MockFileFacts } from './mock.js'

/**
 * The slice of the host's core client the mock needs, named by shape.
 *
 * Only in the mock path: the real server asks core for a file's name over the broker before it
 * records an attachment. `mock.ts` imports nothing and therefore has no client to ask, so the name
 * is resolved here — where `getHost()` is already in hand — and handed in.
 */
interface MockFileApi {
  files: { get(input: { id: string }): Promise<{ name: string; mimeType?: string; size?: number }> }
}

/**
 * This module's API client, made once and shared.
 *
 * The origin comes from the shell, never from an env var read here: same-origin in every real
 * deployment, so a module never has to know which service hosts it or on what port.
 *
 * The shell also decides whether it is running against the in-memory implementation, which satisfies
 * the same contract types — so no screen has a second code path for demos and end-to-end tests.
 */
let cached: InventoryApi | null = null

export function getInventoryApi(): InventoryApi {
  if (cached) return cached
  const host = getHost()
  cached = host.isMock
    ? (createMockInventoryApi({
        describeFile: async (fileId): Promise<MockFileFacts> => {
          try {
            const file = await (host.api as MockFileApi).files.get({ id: fileId })
            return { name: file.name, mimeType: file.mimeType ?? null, size: file.size ?? null }
          } catch {
            // A demo must not lose a file because its record could not be read; the row still
            // says something rather than nothing — and says it in the reader's own language. This
            // was the literal string 'Uploaded file', which is a label this module prints and
            // therefore one of its strings, not data that arrived from somewhere else.
            return { name: t('file_unnamed'), mimeType: null, size: null }
          }
        },
      }) as unknown as InventoryApi)
    : createInventoryClient({ baseUrl: host.apiBaseUrl })
  return cached
}

/** Test seam: install a fake without touching module state elsewhere. */
export function __setInventoryApi(api: InventoryApi | null) {
  cached = api
}
