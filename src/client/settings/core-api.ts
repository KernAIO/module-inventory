/**
 * The slice of core's API this module reaches for, named by shape rather than imported.
 *
 * A module talks to another module through `kernel.call()` on the server; on the client the shell
 * hands over its own configured core client, and typing the seam structurally keeps the dependency
 * pointing one way — inventory does not import core's router type, and core does not know inventory
 * exists.
 *
 * Keep it to what is actually called. A wide type here is a promise about core's surface that this
 * module has no standing to make. Two procedures are all the settings page needs, and both are
 * gated on `core.modules.manage` in `core/src/modules/core/router.ts`.
 */
export interface CoreApi {
  workspaces: {
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
}
