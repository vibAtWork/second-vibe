# Backlog

Theme (from owner): innovative sysadmin tooling that puts evaluated Nix config
into a database and uses SQL — ideally transactions — to make consistent
changes across a fleet. Multiple approaches welcome, one folder each.

1. [done] `projects/nixql` — approach A: SQLite + JSON. Ingest evaluated
   Nix (safe serializer), flatten to (host, path, value). Fleet changes are SQL
   run in one transaction; policies (SQL that must return 0 rows) gate the commit;
   result is emitted as per-host `mkForce` override modules. Changesets, revert, drift.
2. [done] `projects/fleetdb` — approach B: the DB *is* the config. Nix
   reads a JSON export of the DB via `builtins.fromJSON`; SQL schema with real
   relational tables (hosts, users, ssh keys, firewall ports) and constraints;
   one NixOS module turns rows into config.
3. [done, folded into nixql as `ingest --options`] option-aware type checking — ingest NixOS option *types* too, so
   an UPDATE that sets a string where an int is expected fails inside the txn.
4. Fleet "query packs": ready-made SQL policies (password auth off, firewall on,
   stateVersion skew, kernel version skew, users with wheel).
5. Diff two ingests (before/after a nixpkgs bump) as SQL: what changed per host.
6. Postgres JSONB backend for nixql (multi-operator, row-level locking).
7. `nixql serve` — tiny read-only HTTP/JSON query endpoint.
8. Colmena/deploy-rs integration: `--then` hook that deploys only changed hosts.
9. Git integration: each changeset becomes a commit of the overrides dir.
10. Datalog/graph view of `imports` between modules per host.
11. Nix option search index across fleet (which hosts set option X, from which file).
