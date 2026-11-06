-- Every sshd port must be open in the firewall, or you lock yourself out.
SELECT p.host, port.value AS ssh_port
FROM opts p, json_each(p.value) AS port
JOIN opts fw ON fw.host = p.host AND fw.path = 'networking.firewall.allowedTCPPorts'
JOIN opts en ON en.host = p.host AND en.path = 'services.openssh.enable' AND en.value = 'true'
WHERE p.path = 'services.openssh.ports'
  AND port.value NOT IN (SELECT value FROM json_each(fw.value));
