# @kernhq/module-inventory

The asset register for [Kern](https://github.com/KernAIO/app): what the company owns, who holds each
item, and everything that happened to it.

- **Assets** with an auto-assigned tag (`INV-0042`), serial number, purchase date and vendor, price,
  warranty expiry, location, photo and description.
- **Custody**: hand an item to a member and it stays theirs — with the full history of who held it
  before — until somebody hands it on or takes it back.
- **History**: every change to an asset is recorded as an append-only timeline entry: what moved,
  from what, to what, by whom.

Part of a Kern instance; enable it per workspace in **Settings → Modules**.

## Developing

```bash
pnpm install
pnpm typecheck   # tsc + svelte-check over the client
pnpm test
pnpm build
pnpm db:generate # drizzle-kit → migrations/ (RLS policies are hand-written)
```

This package follows the standard Kern module shape: one contract shared by both halves, a server
module hosted by core, and a client module whose screens ship inside this package. See
`docs/adr/0008-a-module-ships-its-own-screens.md` in the app repository for the reasoning.

## Licence

AGPL-3.0-only. This module is part of the Kern product; anything you build for your own Kern
instance does not have to be released, but modifications to this module do.
