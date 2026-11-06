-- Example fleet: 3 hosts, 3 people, a few services.
INSERT INTO hosts(name, domain, ip, env, host_key) VALUES
  ('web1', 'example.net', '10.0.0.11', 'prod',  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIWeb1 root@web1'),
  ('web2', 'example.net', '10.0.0.12', 'prod',  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIWeb2 root@web2'),
  ('db1',  'example.net', '10.0.0.21', 'prod',  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDb1x root@db1');
INSERT INTO users(name, uid, shell) VALUES ('alice', 1000, 'zsh'), ('bob', 1001, 'bash'), ('carol', 1002, 'fish');
INSERT INTO ssh_keys(user, key, comment) VALUES
  ('alice', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAlice alice@laptop', 'laptop'),
  ('bob',   'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBob00 bob@desk', 'desk'),
  ('carol', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICarol carol@x', NULL);
-- alice is an admin everywhere; bob deploys the web tier; carol is a DBA.
INSERT INTO access(user, host, wheel) SELECT 'alice', name, 1 FROM hosts;
INSERT INTO access(user, host, wheel) VALUES ('bob', 'web1', 0), ('bob', 'web2', 0), ('carol', 'db1', 1);
INSERT INTO services(host, name, port, public) VALUES
  ('web1', 'nginx', 443, 1), ('web2', 'nginx', 443, 1),
  ('web1', 'node-exporter', 9100, 0), ('web2', 'node-exporter', 9100, 0),
  ('db1', 'postgresql', 5432, 0), ('db1', 'node-exporter', 9100, 0);
