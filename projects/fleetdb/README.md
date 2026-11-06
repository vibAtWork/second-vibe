# fleetdb — the fleet is a relational database, NixOS reads it

*Approach B of the "Nix config in a database" experiment. Approach A is
[`../nixql`](../nixql), which goes the other way round.*

Most fleet bugs live **between** machines: uid 1001 means bob on one host and
dave on another, the new box is missing from everyone's `known_hosts`, someone
removed the last sudo user from a server, or the database port got opened.
Per-host Nix evaluation can't see any of that, because each host is evaluated alone.

fleetdb keeps the *fleet-level facts* in a normal SQLite schema with real
constraints. NixOS consumes them as data:

```
  SQL in one transaction ─▶ hosts / users / ssh_keys / access / services
                               │  PK, UNIQUE, CHECK, FKs (deferred to commit)
                               │  + `violations` view must be empty
                               ▼
                         `export` view (one JSON doc per host, incl. facts about OTHER hosts)
                               ▼  written atomically on commit
                          fleet.json ──builtins.fromJSON──▶ module.nix ──▶ each NixOS host
```

* **Cross-host invariants at commit time**: fleet-wide unique UIDs (kept below
  NixOS's `nixbld` range), unique IPs, no service on the ssh port, "every host
  keeps an active wheel user with an ssh key" (lockout protection), "databases
  are never public". A failed check rolls back the whole transaction, and
  `fleet.json` is not touched.
* **Derived, fleet-coherent config**: `/etc/hosts` (`networking.hosts`) and
  `programs.ssh.knownHosts` for every host are computed from the `hosts` table.
  One `INSERT` of a new host updates every other machine's config in the same
  transaction.
* **Plan before commit**: `fleetdb plan "<sql>"` shows the per-host NixOS-level
  diff, then rolls back.
* **Audit + undo**: triggers record every row change, including FK cascades.
  `fleetdb undo N` replays the inverse as a new transaction, and the invariants
  check that too.
* SQL runs under an authorizer: no `COMMIT`, `ATTACH`, schema changes, or writes
  to the audit log.

## Try it

```bash
./examples/demo.sh                           # python3 only (nix optional)
python3 -m unittest discover -s tests        # 16 tests
```

## Use it

```bash
./fleetdb.py init -f examples/seed.sql       # creates fleet.sqlite + fleet.json
./fleetdb.py q "SELECT host, group_concat(user) FROM access WHERE wheel GROUP BY host"
./fleetdb.py plan "UPDATE hosts SET ssh_port = 2222 WHERE env = 'prod'"
./fleetdb.py sql -m "ssh on 2222 in prod" "UPDATE hosts SET ssh_port = 2222 WHERE env = 'prod'"
./fleetdb.py log -v ; ./fleetdb.py undo 3 ; ./fleetdb.py status ; ./fleetdb.py show web1
```

In each host's NixOS config:

```nix
imports = [ ./fleetdb/module.nix ];
fleetdb = { file = ./fleet.json; host = "web1"; };
```

`fleet.json` is plain, sorted, deterministic JSON with a `sha256`. Commit it
next to your Nix code, and the git diff of a transaction is exactly what changed
per host. The first 8 hex chars of the sha end up in the system's
`system.nixos.tags`, so `nixos-version` on a box tells you which fleet state it runs.

[`to-nixos.nix`](to-nixos.nix) is the pure mapping from one host's JSON to NixOS
options (users, sudo, sshd, firewall, hosts, known_hosts). It's the place to
extend, and it can be tested without nixpkgs.

## Verified

* 16 tests: constraints, view rules, rollback of DB and file, deferred FKs,
  authorizer, undo round-trips (insert / update / cascading delete / cascading
  rename) that restore the exact export sha, `to-nixos.nix` under `nix eval`, CLI.
* **Real NixOS 25.05**: [`examples/nixos-fleet.nix`](examples/nixos-fleet.nix)
  builds every host in `fleet.json` with `eval-config.nix`. Checked: UIDs, wheel
  membership, firewall ports, known hosts, login shells resolved to packages,
  and `config.system.build.toplevel.drvPath` instantiates (so all NixOS
  assertions pass), about 9 s per host. That run is also what showed the uid
  CHECK had to stay below 30000.

## Limitations

* Only covers what the schema models (hosts, users, keys, access, services).
  Everything else stays in normal per-host Nix. That's deliberate: the DB holds
  the facts that span machines.
* Deployment isn't part of the transaction: committing writes `fleet.json`, and
  rolling it out (nixos-rebuild / colmena / deploy-rs) is still separate.
* Audit triggers attribute every change to the latest transaction row.
  Changes made with a plain `sqlite3` shell outside `fleetdb` are audited but
  mis-attributed, and they skip the invariant check until the next `fleetdb sql`.
* Single-writer SQLite. The same design maps directly onto Postgres (deferred
  constraints, `jsonb_build_object`) if several operators need it.
