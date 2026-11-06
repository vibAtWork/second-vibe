#!/usr/bin/env bash
# One-command tour of nixql on the toy fleet (needs only `nix` and python3).
# Runs in a temp copy so the repo stays clean.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
nixql="$here/../bin/nixql"
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
cp -r "$here/fleet/." "$work/"; cd "$work"; rm -f fleet.db; rm -rf nixql-overrides
step() { printf '\n\033[1m$ %s\033[0m\n' "$*"; }

step nixql ingest fleet.nix;                         "$nixql" ingest fleet.nix
step nixql query '…ssh settings across the fleet…'
"$nixql" q "SELECT host, v AS password_auth FROM o WHERE path='services.openssh.settings.PasswordAuthentication'"
step nixql check;                                    "$nixql" check || true
step "nixql apply 'move sshd to 2222' (forgot the firewall)"
"$nixql" apply -m "sshd on 2222" "UPDATE opts SET value='[2222]' WHERE path='services.openssh.ports'" || true
step "nixql apply (sshd + firewall + no prod passwords, one transaction)"
"$nixql" apply -m "harden ssh" "
  UPDATE opts SET value='[2222]' WHERE path='services.openssh.ports';
  UPDATE opts SET value=json_replace(value, '\$[0]', 2222) WHERE path='networking.firewall.allowedTCPPorts';
  UPDATE opts SET value='false' WHERE path='services.openssh.settings.PasswordAuthentication'
    AND host IN (SELECT host FROM o WHERE path='networking.domain' AND v='prod');"
step cat nixql-overrides/web1.nix;                   cat nixql-overrides/web1.nix
step nixql log -v;                                   "$nixql" log -v
step "nixql revert 1 --dry-run   (policies guard reverts too)"; "$nixql" revert 1 --dry-run || true
