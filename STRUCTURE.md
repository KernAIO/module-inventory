# What a Kern module looks like

One repository, one package, one feature. Everything the feature *is* lives here — and nothing that
isn't the feature lives here.

```
module-<id>/
  src/
    contract/        what this module promises        ← always
    server/          how it keeps that promise        ← always
    client/          its screens and its strings      ← unless it has no interface
    tests/           run it for real and check
  migrations/        its own Postgres schema          ← if it stores anything
```

Everything above is the whole repository. A module never ships a process of its own.

## Most modules do not need a service

If your module is request/response — a form, a list, a report — you are done. `core`
hosts it: its router is mounted at `/api/<id>`, its migrations run, its jobs are scheduled, and you
write no server plumbing at all. Five of the seven modules Kern ships with are like this — only
`chat` and `mail` have their own process.

```jsonc
// src/server/index.ts — the default, and you can omit it entirely
defaultHost: 'core'
```

## When a module needs its own process

A module needs a process of its own when it holds something a request/response service cannot: an
open socket, a long-lived connection to somebody else's system, a queue it drains on its own clock.
Kern's chat module holds WebSocket connections and a presence store; its mail module holds provider
connections and a delivery queue.

That process does not live in the module repository. It lives in a **sibling service repository** —
`KernAIO/chat` and `KernAIO/mail` are examples, one repository per host service, each with its own
Dockerfile, port and CI. The module package (`@kernhq/module-chat`) stays exactly the shape above:
contract, server, client. What changes is where it is hosted:

```jsonc
// src/server/index.ts
defaultHost: 'chat'      // the name of the service repository that hosts this module
```

The service repository then boots the kernel with `[thisModule]` and ships the Dockerfile and
infrastructure the process needs. The module stays installable from npm and testable on its own;
only the process plumbing lives next door.

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
