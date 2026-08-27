# What a Kern module looks like

One repository, one package, one feature. Everything the feature *is* lives here — and nothing that
isn't the feature lives here.

```
module-<id>/
  src/
    contract/        what this module promises        ← always
    server/          how it keeps that promise        ← always
    client/          its screens and its strings      ← unless it has no interface
    service/         a process that hosts it          ← ONLY if it needs one
    tests/           run it for real and check
  migrations/        its own Postgres schema          ← if it stores anything
  Dockerfile                                          ← only if src/service/ exists
```

**The only optional part is `src/service/`.** That one directory is the whole difference between a
small module and one that runs its own process.

## Most modules do not need a service

If your module is request/response — a form, a list, a report — leave `src/service/` out. `core`
hosts it: its router is mounted at `/api/<id>`, its migrations run, its jobs are scheduled, and you
write no server plumbing at all. Five of the seven modules Kern ships with are like this — only
`chat` and `mail` host themselves.

```jsonc
// src/server/index.ts — the default, and you can omit it entirely
defaultHost: 'core'
```

## Some modules do

A module needs its own process when it holds something a request/response service cannot: an open
socket, a long-lived connection to somebody else's system, a queue it drains on its own clock.
Kern's chat module holds WebSocket connections and a presence store; its mail module holds provider
connections and a delivery queue. Both ship a service.

```
src/service/
  main.ts         the entrypoint — dist/service/main.js is what the image runs
  service.ts      boot the kernel with [thisModule], start the server
  env.ts          the variables this service needs, parsed and validated
  gateway.ts      whatever the process exists for
```

```jsonc
// src/server/index.ts
defaultHost: 'my-module'      // this module hosts itself
```

Add a `Dockerfile` beside it and the image builds from this repository.

### Why it is in here and not in a repository of its own

It used to be separate, and the tests told on it: the service repository held the integration tests,
so the module published to npm with **no tests at all** and a green CI that proved nothing. A module
that cannot test itself is not a module.

The other reason is you. If the service lives somewhere only Kern can put it, then a module needing
its own process is something only Kern can write. This way there is one shape, and it is the same
shape whoever is writing it.

## What never lives here

- **The application.** A module contributes screens; it does not contain the shell, the rail, the
  command palette or the dashboard. Those are `KernAIO/app`.
- **The framework.** `@kernhq/ui`, `@kernhq/kernel` and `@kernhq/contracts` are dependencies. If your
  module needs something from the shell that the framework does not export, that is a platform
  change, not a reason to reach into the app — open an issue.
- **Another module.** Modules never import each other. Cross-module work goes through
  `kernel.call('<module>.<procedure>')` and events, which is what lets a workspace switch one off
  without the others noticing.

## The whole wiring, outside this repository

Two lines. That is the entire integration surface:

```ts
// the host service — core, or your own
featureModules = [ …, myModule ]

// repos/shell/src/lib/modules/registry.ts
registerModule(myClientModule)
```
