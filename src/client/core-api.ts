/**
 * The slice of core's API this module reaches for, named by shape rather than imported.
 *
 * A module talks to another module through `kernel.call()` on the server; on the client the shell
 * hands over its own configured core client, and typing the seam structurally keeps the dependency
 * pointing one way — inventory does not import core's router type, and core does not know inventory
 * exists.
 *
 * Keep it to what is actually called. A wide type here is a promise about core's surface that this
 * module has no standing to make: `Member` in core carries a role, role ids, group ids, a status
 * and an invitation trail, and naming any of that here would make this module's screens break when
 * a field it never reads changes shape. Four procedures are all of it, and each is gated in
 * `core/src/modules/core/router.ts` — the two settings calls on `core.modules.manage`, the member
 * list on `core.members.view`, the download URL on the file's own workspace membership.
 */

/**
 * A workspace member, as thinly as a picker and an avatar need one.
 *
 * `name` is nullable in core — somebody invited and not yet signed in has an email and nothing
 * else — so every screen here falls back to the email rather than rendering an empty label.
 */
export interface CoreMember {
  userId: string
  user: {
    id: string
    name: string | null
    email: string
    avatarUrl?: string | null
  }
}

export interface CoreApi {
  workspaces: {
    members: {
      /** Paged in core; this module asks for one large page and keeps the people, not the envelope. */
      list(input: { workspaceId: string; limit?: number }): Promise<{ items: CoreMember[] }>
    }
    modules: {
      list(input: { workspaceId: string }): Promise<
        Array<{
          manifest: { id: string }
          state: {
            enabled: boolean
            settings?: Record<string, unknown>
          }
        }>
      >
      updateSettings(input: {
        workspaceId: string
        moduleId: string
        settings: Record<string, unknown>
      }): Promise<unknown>
    }
  }
  /**
   * Reading a file back.
   *
   * This module records that an asset has a file and never touches a byte — the bytes are core's,
   * the URL is core's to sign, and it is signed for the person asking rather than for this module.
   * `thumbnail: true` is what the asset photo asks for; a full-size photo in a 440px panel is a
   * megabyte nobody looks at.
   */
  files: {
    downloadUrl(input: {
      id: string
      disposition?: 'inline' | 'attachment'
      thumbnail?: boolean
    }): Promise<{ url: string }>
  }
}
