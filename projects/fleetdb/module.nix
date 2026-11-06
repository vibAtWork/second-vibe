# NixOS module: configure this host from fleetdb's export.
#   imports = [ ./fleetdb/module.nix ];
#   fleetdb = { file = ./fleet.json; host = "web1"; };
{ config, lib, pkgs, ... }:
let
  cfg = config.fleetdb;
  doc = builtins.fromJSON (builtins.readFile cfg.file);
  me = doc.hosts.${cfg.host} or (throw "fleetdb: host '${cfg.host}' not in ${toString cfg.file}");
  generated = import ./to-nixos.nix { inherit pkgs; } me;
in
{
  options.fleetdb = {
    file = lib.mkOption { type = lib.types.path; description = "fleetdb export (fleet.json)."; };
    host = lib.mkOption { type = lib.types.str; description = "This host's name in fleetdb."; };
  };
  # Keys are listed statically so the module system can see them without forcing `doc`.
  config = {
    inherit (generated) networking services programs users security;
    system.nixos.tags = [ "fleetdb-${builtins.substring 0 8 doc.sha256}" ];
  };
}
