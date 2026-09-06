---
'@kernhq/module-inventory': patch
---

Bind the `'*'` sentinel for the registry read the nightly sweeps start from

`mod_inventory.workspaces` is the table both nightly sweeps enumerate, and it was readable by a
transaction with **no** workspace bound — so any code path that reached it having forgotten to bind
got rows back rather than a refusal, silently. `module-chat` and `module-mail` answer the same
question with a sentinel the caller types on purpose, and `0010_workspace_registry_all_binding.sql`
brings this module into line: a `for select` policy admitting `app.workspace_id = '*'`, and
`activeWorkspaces` binds it.

Append-only, and both policies stand for one release. The previous version enumerates this table
unbound, and a rolling deploy runs two adjacent releases against one schema — so dropping the
unbound policy now would hand the image being replaced zero rows and the silent do-nothing sweep it
was written to fix. The migration header names the release that may drop it.
