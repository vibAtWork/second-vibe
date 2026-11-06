# Every host in fleet.json as a real NixOS system, configured by module.nix.
#   NIXPKGS=/path/to/nixpkgs nix eval --impure -f nixos-fleet.nix web1.config.users.users.alice.uid
{ nixpkgs ? (let e = builtins.getEnv "NIXPKGS"; in if e != "" then e else <nixpkgs>)
, file ? ./fleet.json }:
let
  doc = builtins.fromJSON (builtins.readFile file);
in builtins.mapAttrs (name: _: import "${nixpkgs}/nixos/lib/eval-config.nix" {
  system = "x86_64-linux";
  modules = [
    ../module.nix
    {
      fleetdb = { inherit file; host = name; };
      # hardware-ish bits that would normally live in the host's own config
      boot.loader.grub.enable = false;
      fileSystems."/".device = "/dev/disk/by-label/nixos";
      system.stateVersion = "25.05";
    }
  ];
}) doc.hosts
