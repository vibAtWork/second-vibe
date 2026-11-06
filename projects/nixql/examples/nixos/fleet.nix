# A real NixOS fleet (3 hosts) evaluated with nixpkgs' eval-config.
# nixpkgs comes from $NIXPKGS (a nixpkgs checkout / channel tarball dir) or <nixpkgs>.
# Each host imports its nixql override module if one has been generated.
let
  env = builtins.getEnv "NIXPKGS";
  nixpkgs = if env != "" then env else <nixpkgs>;
  overrides = ./nixql-overrides;
  hasOverrides = builtins.pathExists (overrides + "/default.nix");

  mkHost = name: extra: import "${nixpkgs}/nixos/lib/eval-config.nix" {
    system = "x86_64-linux";
    modules = [
      ({ ... }: {
        networking.hostName = name;
        boot.loader.grub.enable = false;
        fileSystems."/".device = "/dev/disk/by-label/nixos";
        system.stateVersion = "25.05";
        services.openssh.enable = true;
        services.openssh.settings.PasswordAuthentication = true;
        networking.firewall.allowedTCPPorts = [ 22 ];
        users.users.ops = { isNormalUser = true; extraGroups = [ "wheel" ]; };
      })
      extra
    ] ++ (if hasOverrides then [ (import overrides).${name} or { } ] else [ ]);
  };
in {
  web1 = mkHost "web1" { networking.domain = "prod"; services.nginx.enable = true;
                         networking.firewall.allowedTCPPorts = [ 80 443 ]; };
  db1  = mkHost "db1"  { networking.domain = "prod"; services.postgresql.enable = true; };
  dev1 = mkHost "dev1" { networking.domain = "dev"; time.timeZone = "Europe/Copenhagen"; };
}
