# Summary: Nix config in a database, changed with SQL transactions

Two working approaches to the owner's prompt, each in its own folder, each tested
against a real NixOS 25.05 evaluation.

## 1. `projects/nixql`: evaluated Nix → SQLite → SQL edits → mkForce modules  *(review first)*
Ingest a fleet's evaluated NixOS config as `(host, path, JSON value)` rows. Query
across machines with SQL. Change many machines in **one transaction** that is
gated by SQL policies and by the real NixOS option types. Committed changes become
generated per-host `lib.mkForce` modules; changesets can be reverted and drift is
detected on re-evaluation. A `why` view shows which files define a value.

```bash
projects/nixql/examples/demo.sh
```

## 2. `projects/fleetdb`: the DB is the source of truth, Nix reads its JSON export
A relational schema (hosts, users, keys, access, services) with **cross-host**
invariants: unique UIDs fleet-wide, no lockouts, no public databases. Derived
config like `/etc/hosts` and `known_hosts` for every host is computed in SQL.
SQL transactions get plan/commit/undo with audit. A NixOS module consumes `fleet.json`.

```bash
projects/fleetdb/examples/demo.sh
```

## What to review
* `projects/nixql/nixql/core.py` → `apply()`: the transaction + authorizer + policy
  + emit ordering is the heart of approach A.
* `projects/fleetdb/schema.sql`: the `violations` and `export` views are the
  whole idea of approach B in ~80 lines of SQL.
* Real-NixOS checks need a nixpkgs path: `NIXPKGS=/path/to/nixpkgs`. See each README.
* Both are single-writer SQLite and stop short of deployment. Rollout stays a separate step.
