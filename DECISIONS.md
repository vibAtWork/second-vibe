# Decisions

- **SQLite (Python stdlib) for approach A.** Zero dependencies, real ACID
  transactions, good JSON functions (`->>`, `json_each`, `json_set`). Postgres 16
  client exists but no server; JSONB backend kept on the backlog.
- **Flatten to leaves, lists are leaves.** NixOS lists merge as whole values, and
  SQLite's `json_each` makes list membership queries easy anyway.
- **Writes become `lib.mkForce` override modules, not edits to the user's .nix.**
  Rewriting arbitrary Nix source is fragile; a generated per-host module that the
  host imports is reviewable, revertable and `git diff`-able.
- **Overrides are cumulative state in the DB**, not a diff against the last eval.
  Once overrides are deployed, re-evaluation includes them, so a diff would be
  empty and would silently drop them.
- **nixpkgs for the demo is the 25.05 channel tarball** from releases.nixos.org
  (the GitHub API is blocked from this session), kept in the scratchpad, not committed.
- **Approach B is a separate project (`fleetdb`), not a nixql mode.** It inverts the
  data flow (DB → Nix instead of Nix → DB), so it shares almost no code; the owner
  asked for one folder per approach.
- **fleetdb uid range capped at 29999**, found by the real-NixOS check: nixbld users
  occupy 30001+.
- **Option type checking was folded into nixql** rather than a third folder: it's
  an extension of nixql's data model (same tables, same apply path), not a new approach.
- **Unknown NixOS types are permissive** ("can't tell" → allowed) so type checks
  never block valid edits; only definitely-wrong values are rejected.
