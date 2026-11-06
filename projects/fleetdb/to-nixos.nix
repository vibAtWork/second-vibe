# Pure function: one host's fleetdb export -> NixOS config attrset.
# Takes `pkgs` only to resolve login shells; pass null to keep shells as names
# (handy for testing without nixpkgs).
{ pkgs ? null }:
me:
let
  shellOf = name: if pkgs == null then name else pkgs.${if name == "bash" then "bashInteractive" else name};
  usesShell = s: builtins.any (u: u.shell == s) (builtins.attrValues me.users);
in
{
  networking.hostName = me.hostName;
  networking.domain = me.domain;
  networking.hosts = me.etcHosts;                       # every other host in the fleet
  networking.firewall.enable = true;
  networking.firewall.allowedTCPPorts = me.tcpPorts;    # ssh + public services
  services.openssh = {
    enable = true;
    ports = [ me.sshPort ];
    openFirewall = false;                               # fleetdb owns the firewall list
    settings.PasswordAuthentication = false;
    settings.PermitRootLogin = "no";
  };
  programs.ssh.knownHosts = me.knownHosts;              # host keys of every other host
  programs.zsh.enable = usesShell "zsh";
  programs.fish.enable = usesShell "fish";
  users.mutableUsers = false;
  users.users = builtins.mapAttrs (_: u: {
    isNormalUser = true;
    uid = u.uid;
    shell = shellOf u.shell;
    extraGroups = if u.wheel then [ "wheel" ] else [ ];
    openssh.authorizedKeys.keys = u.keys;
  }) me.users;
  security.sudo.wheelNeedsPassword = false;            # users have no passwords
}
