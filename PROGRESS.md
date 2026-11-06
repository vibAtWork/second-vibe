# Progress

- 2026-11-06 21:45 UTC — Bootstrapped bookkeeping. Started `projects/nixql`
  (approach A). Wrote `nixql/serialize.nix` safe serializer; checked that it
  evaluates a real NixOS 25.05 config subtree in ~3s. Status: in progress.
- 2026-11-06 23:40 UTC — `projects/nixql` (approach A) finished: transactional
  apply with policies + SQLite authorizer, mkForce override emission (atomic dir
  swap), changesets/revert, drift. Verified on toy fleet and on a real NixOS 25.05
  fleet (3 hosts, ~4400 leaves). 30 tests. Status: done.
- 2026-11-06 23:45 UTC — `projects/fleetdb` (approach B) finished: relational
  schema with cross-host invariants (`violations` view), JSON export view consumed
  by a NixOS module, audit triggers + undo, plan. Verified: real NixOS
  `toplevel.drvPath` instantiates from fleet.json. 16 tests. Status: done.
- 2026-11-06 23:55 UTC — nixql `ingest --options`: NixOS option types and
  defining files (submodules + `<name>` wildcards), type checks in apply, `why`
  view. 35 tests (one gated on $NIXPKGS). Status: done.
