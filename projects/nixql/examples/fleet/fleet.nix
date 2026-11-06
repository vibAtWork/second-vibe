# A toy fleet that needs no nixpkgs: each host is a NixOS-shaped config attrset.
# (For real NixOS systems see examples/nixos/fleet.nix; nixql uses `.config`.)
let
  # Recursive attrset merge (like lib.recursiveUpdate) so hosts can extend `base`.
  merge = a: b: a // builtins.mapAttrs (n: v:
    if builtins.isAttrs v && builtins.isAttrs (a.${n} or null) then merge a.${n} v else v) b;
  base = name: {
    networking.hostName = name;
    networking.firewall = { enable = true; allowedTCPPorts = [ 22 ]; };
    services.openssh = {
      enable = true;
      ports = [ 22 ];
      settings = { PasswordAuthentication = true; PermitRootLogin = "prohibit-password"; };
    };
    time.timeZone = "UTC";
    system.stateVersion = "24.11";
    users.users.root.openssh.authorizedKeys.keys = [ "ssh-ed25519 AAAA...ops" ];
  };
in {
  web1 = merge (base "web1") { networking.domain = "prod"; services.nginx.enable = true; };
  web2 = merge (base "web2") { networking.domain = "prod"; services.nginx.enable = true;
                         system.stateVersion = "23.11"; };
  db1  = merge (base "db1") { networking.domain = "prod"; services.postgresql = { enable = true; port = 5432; }; };
  dev1 = merge (base "dev1") { networking.domain = "dev"; time.timeZone = "Europe/Copenhagen"; };
}
