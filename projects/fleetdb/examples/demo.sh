#!/usr/bin/env bash
# One-command tour of fleetdb (python3 only; nix optional for the last step).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT; cd "$work"
f() { python3 "$here/../fleetdb.py" "$@"; }
step() { printf '\n\033[1m$ fleetdb %s\033[0m\n' "$*"; }

step "init -f seed.sql";  f init -f "$here/seed.sql" | tail -2
step "q 'who can sudo where'"
f q "SELECT a.host, group_concat(a.user) AS wheel FROM access a WHERE wheel GROUP BY host"
step "sql 'add web3' (one INSERT, every host's /etc/hosts + known_hosts change)"
f sql -m "add web3" "
  INSERT INTO hosts(name, domain, ip, host_key) VALUES ('web3','example.net','10.0.0.13','ssh-ed25519 AAAAC3Nz web3');
  INSERT INTO access(user, host, wheel) VALUES ('alice','web3',1), ('bob','web3',0);
  INSERT INTO services VALUES ('web3','nginx',443,1);"
step "sql 'take away alice'\''s sudo' (would lock us out)"; f sql "UPDATE access SET wheel=0 WHERE user='alice'" || true
step "sql 'open postgres to the world'";                   f sql "UPDATE services SET public=1 WHERE name='postgresql'" || true
step "sql 'reuse uid 1001'";                               f sql "INSERT INTO users VALUES ('dave',1001,'bash',1)" || true
step "plan 'move ssh to 2222 on prod'"; f plan "UPDATE hosts SET ssh_port=2222 WHERE env='prod'"
step "log";    f log
step "undo 2"; f undo 2 | tail -3
if command -v nix >/dev/null; then
  step "(nix) evaluate db1's NixOS user config from fleet.json"
  nix eval --impure --json --expr "(import $here/../to-nixos.nix {} (builtins.fromJSON (builtins.readFile ./fleet.json)).hosts.db1).users.users"
  echo
fi
