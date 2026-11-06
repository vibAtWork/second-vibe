# nixql — your NixOS fleet as a SQL table, with transactions

*Approach A of the "Nix config in a database" experiment.*

nixql evaluates the NixOS configs of many machines, flattens them into one
SQLite table, and lets you:

* **query the whole fleet with SQL**: "which hosts allow SSH passwords?",
  "who is in `wheel`, where?", "which hosts are on an old `stateVersion`?"
* **change the whole fleet with SQL in one transaction**: `UPDATE opts SET …`
  across any set of hosts. Before commit, **policies** (plain SQL `SELECT`s
  that must return no rows) run against the *proposed* state. If any fails, the
  whole thing rolls back and nothing is written.
* **get Nix back out**: committed changes become one generated module per host
  (`lib.mkForce` assignments) that the host imports. They're reviewable,
  `git diff`-able and deterministic.
* **keep history**: every apply is a changeset with old/new values. You can
  `revert` it, with conflict detection, and policies check reverts too.
* **detect drift**: after you re-evaluate, overrides the evaluation doesn't
  reflect yet (not imported, not deployed) show up in `status`.

```
 hosts/*.nix ──nix eval──▶ evaluated(host,path,value) ─┐
                                                       ├─▶ opts  ◀── your SQL (one txn)
                         overrides(host,path,value) ───┘     │
                               ▲                             ▼ policies/*.sql must return 0 rows
                               └──── changeset ◀── commit ───┘
                                        │
                                        ▼
                        nixql-overrides/<host>.nix  (lib.mkForce …)  ──imported by──▶ hosts
```

## Try it (one command)

```bash
./examples/demo.sh        # toy fleet, needs only nix + python3 (stdlib only)
python3 -m unittest discover -s tests   # 30 tests
```

## Usage

```bash
bin/nixql ingest fleet.nix --select services.openssh,networking.firewall,users.users
bin/nixql q "SELECT host, v FROM o WHERE path = 'services.openssh.settings.PasswordAuthentication'"
bin/nixql check                       # run ./policies/*.sql against desired state
bin/nixql apply -n -f change.sql      # dry run: show the plan, roll back
bin/nixql apply -m "harden ssh" -f change.sql
bin/nixql log -v ; bin/nixql revert 3 ; bin/nixql status ; bin/nixql show web1
```

**Sources** (`ingest`): a `.nix` file evaluating to `{ host = <NixOS system or
plain config attrset>; … }`, a flake directory (`nixosConfigurations`, uses
`--impure`), or a `.json` file of the same shape. For NixOS systems `.config`
is used. `--select` keeps only some subtrees. You want this: a whole NixOS
config is tens of thousands of leaves, and some subtrees are expensive or throw.

Values Nix can't express as JSON are stored as markers by
[`serialize.nix`](nixql/serialize.nix), e.g. `{"__nixql":"derivation","name":"bash-5.2"}`,
`{"__nixql":"function"}` or `{"__nixql":"error"}` (for a `throw`). The whole
evaluation doesn't fail because of them.

**Wiring the overrides into hosts.** Add the generated module to each host:

```nix
# in nixosConfigurations.<name> modules (or fleet.nix, see examples/nixos):
imports = [ (import ./nixql-overrides).${name} ];
```

`nixql-overrides/` is owned by nixql and swapped in whole (staged dir + rename)
only after the DB transaction commits. nixql refuses to replace a directory it
didn't create.

## The tables

| table / view | what |
|---|---|
| `opts(host, path, value)` | **desired state**: the only table your SQL may write |
| `o(host, path, value, v)` | view of `opts` with `v = value ->> '$'` (scalar-decoded) |
| `evaluated(host, path, value)` | leaves of the last `nix eval` |
| `overrides(host, path, value, changeset)` | what nixql owns and emits |
| `drift` | overrides that the last evaluation doesn't reflect |
| `changesets`, `changes` | history; `changes` has old/new value per leaf |
| `hosts(name, source, ingested_at)` | |

* `path` is a Nix attribute path in Nix syntax (`users.users."bob.smith".shell`),
  so it can be pasted into a `.nix` file.
* `value` is JSON text. Lists are leaves (Nix merges them as whole values). Use
  `json_each` to look inside, and `json_insert` / `json_replace` / `json_remove`
  to edit them. On write, SQL numbers become JSON numbers and text that isn't
  valid JSON becomes a JSON string. `'true'` is a boolean and `'"true"'` is a string.
* Extra SQL functions: `nix(value)` renders a Nix literal; `path_segs(path)` and
  `path_join(json_array)`.

### Examples

```sql
-- Who has wheel, where? (qualify columns inside json_each subqueries!)
SELECT o.host, o.path FROM opts o, json_each(o.value) g
WHERE o.path LIKE 'users.users.%.extraGroups' AND g.value = 'wheel';

-- Move sshd to 2222 everywhere and keep the firewall consistent, atomically:
UPDATE opts SET value = '[2222]' WHERE path = 'services.openssh.ports';
UPDATE opts SET value = (SELECT json_group_array(x) FROM
         (SELECT j.value x FROM json_each(opts.value) j WHERE j.value <> 22 UNION SELECT 2222))
  WHERE path = 'networking.firewall.allowedTCPPorts';

-- Target hosts by any property of their config:
UPDATE opts SET value = 'false'
WHERE path = 'services.openssh.settings.PasswordAuthentication'
  AND host IN (SELECT host FROM o WHERE path = 'networking.domain' AND v = 'prod');

-- Add a brand-new option (inserted rows become overrides too):
INSERT INTO opts VALUES ('db1', 'services.prometheus.exporters.node.enable', 'true');
```

A policy is a file in `policies/` (or `--policy FILE`, or `--check 'SELECT …'`).
See [`examples/fleet/policies`](examples/fleet/policies), e.g. "every sshd port
is open in the firewall", which is exactly the lockout the transaction saves you from.

## Safety

* User SQL runs under a SQLite **authorizer**. It may read everything but write
  only `opts` and `TEMP` tables. It can't `COMMIT`, `ATTACH`, change the schema,
  or write history. `query` opens the DB read-only. Policies run read-only.
* Deleting a leaf that Nix defines is refused: Nix can't "unset" an option, so
  set it to `null` / `false` / `[]` instead. Deleting a leaf that only exists
  because nixql added it removes the override.
* Values that are markers (functions, derivations) can't be written back.

## Verified

* 30 unit/integration tests (`tests/`), including evaluating the generated
  modules with `nix eval` and running the CLI end to end.
* A **real NixOS 25.05** fleet ([`examples/nixos/fleet.nix`](examples/nixos/fleet.nix),
  3 hosts, ~4400 leaves with `users.users` selected, about 9 s to evaluate).
  Run apply, then re-ingest with the overrides imported: `status` reports no
  drift. Derived values follow too: the generated `sshd_config` text in
  `services.openssh.extraConfig` says `Port 2222`.
  Try it with `NIXPKGS=/path/to/nixpkgs bin/nixql ingest examples/nixos/fleet.nix --select services.openssh,networking.firewall,networking.domain`.

## Limitations / honest caveats

* **It edits by overriding, not by rewriting your Nix.** Changes are `mkForce`
  values on top, so the original definition still sits in your `.nix` files.
  Fine for fleet-wide policy changes. For permanent changes, fold them back into
  the source eventually.
* `mkForce` replaces whole lists, so it doesn't merge with other definitions.
  That's intended (you see exactly what you get) but differs from normal list merging.
* Overrides are keyed by the evaluated *attribute path*. If a NixOS option is
  renamed upstream, the override keeps the old path, gets a rename warning, or
  fails eval. Check `status`/`drift` after nixpkgs bumps.
* The "transaction" covers the database and the generated files. It does not
  cover deployment: pushing to machines (colmena, deploy-rs, nixos-rebuild) is
  still a separate, non-atomic step. `apply --hosts-only` prints the hosts to deploy.
* Values are JSON, so ints/floats/strings/bools/null/lists/attrsets round-trip.
  Nix paths become strings, and there is no `lib.mkIf`/`mkDefault` structure.
* A single-writer SQLite file, not a multi-operator server.
