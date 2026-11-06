-- fleetdb schema: the fleet as relational data. Nix reads the `export` view.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS hosts (
  name      TEXT PRIMARY KEY CHECK (name GLOB '[a-z]*' AND name NOT GLOB '*[^a-z0-9-]*'),
  domain    TEXT NOT NULL DEFAULT 'internal',
  ip        TEXT NOT NULL UNIQUE CHECK (ip GLOB '*.*.*.*'),
  ssh_port  INTEGER NOT NULL DEFAULT 22 CHECK (ssh_port BETWEEN 1 AND 65535),
  host_key  TEXT CHECK (host_key IS NULL OR host_key GLOB 'ssh-* *'),  -- ed25519 host pubkey
  env       TEXT NOT NULL DEFAULT 'prod' CHECK (env IN ('prod', 'staging', 'dev'))
);

CREATE TABLE IF NOT EXISTS users (
  name   TEXT PRIMARY KEY CHECK (name NOT GLOB '*[^a-z0-9_-]*'),
  uid    INTEGER NOT NULL UNIQUE CHECK (uid BETWEEN 1000 AND 29999),  -- same uid everywhere; NixOS nixbld users start at 30001
  shell  TEXT NOT NULL DEFAULT 'bash' CHECK (shell IN ('bash', 'zsh', 'fish')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS ssh_keys (
  user    TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE ON UPDATE CASCADE,
  key     TEXT NOT NULL UNIQUE CHECK (key GLOB 'ssh-* *' OR key GLOB 'ecdsa-* *'),
  comment TEXT
);

-- Which users exist on which hosts, and whether they get wheel there.
CREATE TABLE IF NOT EXISTS access (
  user  TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE ON UPDATE CASCADE,
  host  TEXT NOT NULL REFERENCES hosts(name) ON DELETE CASCADE ON UPDATE CASCADE,
  wheel INTEGER NOT NULL DEFAULT 0 CHECK (wheel IN (0, 1)),
  PRIMARY KEY (user, host)
);

CREATE TABLE IF NOT EXISTS services (
  host  TEXT NOT NULL REFERENCES hosts(name) ON DELETE CASCADE ON UPDATE CASCADE,
  name  TEXT NOT NULL,
  port  INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  public INTEGER NOT NULL DEFAULT 0 CHECK (public IN (0, 1)),  -- open in the firewall?
  PRIMARY KEY (host, name),
  UNIQUE (host, port)
);

-- Cross-row rules that CHECK/UNIQUE can't express. Every row is a violation;
-- fleetdb refuses to commit while this view is non-empty.
CREATE VIEW IF NOT EXISTS violations AS
  SELECT 'host has no active wheel user (lockout risk)' AS rule, h.name AS subject
  FROM hosts h WHERE NOT EXISTS (
    SELECT 1 FROM access a JOIN users u ON u.name = a.user
    WHERE a.host = h.name AND a.wheel AND u.active
      AND EXISTS (SELECT 1 FROM ssh_keys k WHERE k.user = u.name))
  UNION ALL
  SELECT 'service port collides with ssh port', s.host || ':' || s.name
  FROM services s JOIN hosts h ON h.name = s.host WHERE s.port = h.ssh_port
  UNION ALL
  SELECT 'database exposed in firewall', s.host || ':' || s.name
  FROM services s WHERE s.public AND s.name IN ('postgresql', 'mysql', 'redis', 'mongodb')
  UNION ALL
  SELECT 'wheel user without any ssh key', a.user || '@' || a.host
  FROM access a JOIN users u ON u.name = a.user
  WHERE a.wheel AND u.active AND NOT EXISTS (SELECT 1 FROM ssh_keys k WHERE k.user = a.user);

-- Audit log, filled by triggers (see fleetdb.py, generated for every table).
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY, txn INTEGER, at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ')),
  tbl TEXT, op TEXT, old TEXT, new TEXT);
CREATE TABLE IF NOT EXISTS txns (
  id INTEGER PRIMARY KEY, at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ')), message TEXT, export_sha TEXT);

-- The ONE interface between the database and Nix: a JSON document per host.
-- Everything a host needs, including facts about *other* hosts, is computed here.
CREATE VIEW IF NOT EXISTS export AS
SELECT h.name AS host, json_object(
  'hostName', h.name,
  'domain', h.domain,
  'env', h.env,
  'sshPort', h.ssh_port,
  'tcpPorts', (SELECT json_group_array(p) FROM (
      SELECT h.ssh_port AS p UNION SELECT port FROM services WHERE host = h.name AND public ORDER BY 1)),
  'services', (SELECT json_group_object(name, port) FROM (
      SELECT name, port FROM services WHERE host = h.name ORDER BY name)),
  'users', (SELECT json_group_object(u.name, json_object(
      'uid', u.uid, 'shell', u.shell, 'wheel', json(CASE WHEN a.wheel THEN 'true' ELSE 'false' END),
      'keys', (SELECT json_group_array(key) FROM (SELECT key FROM ssh_keys WHERE user = u.name ORDER BY key))))
    FROM (SELECT * FROM access WHERE host = h.name ORDER BY user) a
    JOIN users u ON u.name = a.user WHERE u.active),
  -- fleet-wide facts: every host knows every other host
  'etcHosts', (SELECT json_group_object(ip, json_array(o.name || '.' || o.domain, o.name)) FROM (
      SELECT * FROM hosts WHERE name <> h.name ORDER BY name) o),
  'knownHosts', (SELECT json_group_object(o.name, json_object(
      'hostNames', json_array(o.name, o.name || '.' || o.domain, o.ip), 'publicKey', o.host_key)) FROM (
      SELECT * FROM hosts WHERE host_key IS NOT NULL AND name <> h.name ORDER BY name) o)
) AS config
FROM hosts h;
