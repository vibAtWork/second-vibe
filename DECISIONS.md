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
