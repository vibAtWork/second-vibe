"""nixql core: evaluated Nix config in SQLite, fleet changes as SQL transactions.

Data model (all values are JSON text):

  hosts(name, source, ingested_at)          one row per machine
  evaluated(host, path, value)              leaves of the last `nix eval` (read-only)
  opts(host, path, value)                   desired state = evaluated + overrides  <- you edit this
  overrides(host, path, value, changeset)   what nixql owns; emitted as mkForce modules
  changesets(id, at, message, sql, reverts) history
  changes(changeset, host, path, old_value, new_value, had_override, old_override)

`path` is a Nix attribute path in Nix syntax (`users.users."bob.smith".shell`),
so it can be pasted straight into a .nix file.
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERIALIZER = HERE / "serialize.nix"
MARKER_FILE = ".nixql-generated"

SCHEMA = """
CREATE TABLE IF NOT EXISTS hosts(
  name TEXT PRIMARY KEY, source TEXT, ingested_at TEXT);
CREATE TABLE IF NOT EXISTS evaluated(
  host TEXT NOT NULL REFERENCES hosts(name), path TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY(host, path)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS opts(
  host TEXT NOT NULL REFERENCES hosts(name), path TEXT NOT NULL, value TEXT,
  PRIMARY KEY(host, path)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS overrides(
  host TEXT NOT NULL, path TEXT NOT NULL, value TEXT NOT NULL, changeset INTEGER,
  PRIMARY KEY(host, path)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS changesets(
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, message TEXT, sql TEXT, reverts INTEGER);
CREATE TABLE IF NOT EXISTS changes(
  changeset INTEGER NOT NULL REFERENCES changesets(id), host TEXT, path TEXT,
  old_value TEXT, new_value TEXT, had_override INTEGER, old_override TEXT);
CREATE INDEX IF NOT EXISTS opts_path ON opts(path);
-- Convenience: scalar-decoded value (`v`) for easy WHERE clauses.
CREATE VIEW IF NOT EXISTS o AS
  SELECT host, path, value, value ->> '$' AS v FROM opts;
-- Overrides that the last evaluation does not reflect yet (not deployed / not imported).
CREATE VIEW IF NOT EXISTS drift AS
  SELECT ov.host, ov.path, ov.value AS wanted, ev.value AS evaluated, ov.changeset
  FROM overrides ov LEFT JOIN evaluated ev USING(host, path)
  WHERE ev.value IS NULL OR json(ev.value) <> json(ov.value);
"""


class NixqlError(Exception):
    pass


class PolicyViolation(NixqlError):
    def __init__(self, violations):
        self.violations = violations  # list of (policy_name, columns, rows)
        n = sum(len(r) for _, _, r in violations)
        super().__init__(f"{n} policy violation(s); transaction rolled back")


# --------------------------------------------------------------------------
# Nix attribute paths
# --------------------------------------------------------------------------
_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_'-]*$")
_KEYWORDS = {"if", "then", "else", "assert", "with", "let", "in", "rec", "inherit", "or"}


def quote_seg(seg: str) -> str:
    if _IDENT.match(seg) and seg not in _KEYWORDS:
        return seg
    return nix_string(seg)


def join_path(segs) -> str:
    return ".".join(quote_seg(s) for s in segs)


def split_path(path: str) -> list[str]:
    """Parse `a.b."c.d".e` into ['a', 'b', 'c.d', 'e']."""
    segs, i, n = [], 0, len(path)
    while i < n:
        if path[i] == '"':
            i += 1
            buf = []
            while i < n and path[i] != '"':
                if path[i] == "\\" and i + 1 < n:
                    i += 1
                    buf.append({"n": "\n", "t": "\t", "r": "\r"}.get(path[i], path[i]))
                else:
                    buf.append(path[i])
                i += 1
            if i >= n:
                raise NixqlError(f"unterminated quote in path: {path!r}")
            i += 1
            segs.append("".join(buf))
        else:
            j = i
            while j < n and path[j] != ".":
                j += 1
            seg = path[i:j]
            if not seg:
                raise NixqlError(f"empty segment in path: {path!r}")
            segs.append(seg)
            i = j
        if i < n:
            if path[i] != ".":
                raise NixqlError(f"bad path: {path!r}")
            i += 1
            if i == n:
                raise NixqlError(f"trailing dot in path: {path!r}")
    if not segs:
        raise NixqlError("empty path")
    return segs


# --------------------------------------------------------------------------
# Nix literal rendering
# --------------------------------------------------------------------------
def nix_string(s: str) -> str:
    out = s.replace("\\", "\\\\").replace('"', '\\"').replace("${", "\\${")
    out = out.replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    return f'"{out}"'


def nix_literal(v, indent: int = 0) -> str:
    pad = "  " * indent
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, int):
        return str(v) if v >= 0 else f"({v})"
    if isinstance(v, float):
        r = repr(v)
        if "e" in r or "inf" in r or "nan" in r:
            raise NixqlError(f"cannot render float {v!r} as Nix")
        return r if v >= 0 else f"({r})"
    if isinstance(v, str):
        return nix_string(v)
    if isinstance(v, list):
        if not v:
            return "[ ]"
        items = [nix_literal(x, indent + 1) for x in v]
        if all("\n" not in x for x in items) and sum(len(x) for x in items) < 60:
            return "[ " + " ".join(items) + " ]"
        return "[\n" + "".join(f"{pad}  {x}\n" for x in items) + f"{pad}]"
    if isinstance(v, dict):
        if "__nixql" in v:
            raise NixqlError(f"cannot write back a non-data value ({v['__nixql']})")
        if not v:
            return "{ }"
        body = "".join(
            f"{pad}  {quote_seg(k)} = {nix_literal(x, indent + 1)};\n" for k, x in v.items()
        )
        return "{\n" + body + f"{pad}}}"
    raise NixqlError(f"cannot render {type(v).__name__} as Nix")


# --------------------------------------------------------------------------
# Flattening
# --------------------------------------------------------------------------
def flatten(cfg, prefix=()):
    """Yield (segs, value) leaves. Lists, scalars, {} and marker objects are leaves."""
    if isinstance(cfg, dict) and cfg and "__nixql" not in cfg:
        for k, v in cfg.items():
            yield from flatten(v, prefix + (k,))
    else:
        if prefix:
            yield prefix, cfg


def canon(value) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


# --------------------------------------------------------------------------
# Evaluation
# --------------------------------------------------------------------------
def _nix_eval_json(expr: str, impure: bool = True) -> dict:
    cmd = ["nix", "eval", "--json", "--extra-experimental-features", "nix-command flakes"]
    if impure:
        cmd.append("--impure")
    cmd += ["--expr", expr]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True)
    except FileNotFoundError as e:
        raise NixqlError("`nix` not found on PATH") from e
    if p.returncode != 0:
        raise NixqlError("nix eval failed:\n" + p.stderr.strip()[-4000:])
    return json.loads(p.stdout)


def _select_expr(select: list[str] | None) -> str:
    """Nix function picking the given attribute paths out of a config."""
    if not select:
        return "cfg: cfg"
    picks = []
    for p in select:
        segs = split_path(p)
        lit = "[ " + " ".join(nix_string(s) for s in segs) + " ]"
        picks.append(lit)
    return (
        "cfg: builtins.foldl' (acc: p: lib.recursiveUpdate acc "
        "(lib.setAttrByPath p (lib.attrByPath p null cfg))) { } [ " + " ".join(picks) + " ]"
    )


# A tiny subset of nixpkgs.lib so selection works without nixpkgs.
_MINILIB = r"""
lib = rec {
  attrByPath = p: d: s: if p == [ ] then s
    else let h = builtins.head p; in
      if builtins.isAttrs s && s ? ${h} then attrByPath (builtins.tail p) d s.${h} else d;
  setAttrByPath = p: v: if p == [ ] then v
    else { ${builtins.head p} = setAttrByPath (builtins.tail p) v; };
  recursiveUpdate = a: b: a // builtins.mapAttrs (n: bv:
    if builtins.isAttrs bv && a ? ${n} && builtins.isAttrs a.${n}
    then recursiveUpdate a.${n} bv else bv) b;
};
"""


def eval_fleet(source: str, kind: str = "auto", select: list[str] | None = None,
               max_depth: int = 16, hosts: list[str] | None = None) -> dict[str, dict]:
    """Evaluate a fleet to {host: config-json}.

    kind:
      json   - file with {host: config}
      nix    - file evaluating to {host: <config attrset | nixos system>}
      flake  - flake path; uses nixosConfigurations
      auto   - by extension / flake.nix presence
    For NixOS systems (attrsets with `.config`), `.config` is used.
    """
    src = Path(source)
    if kind == "auto":
        if src.is_dir() and (src / "flake.nix").exists():
            kind = "flake"
        elif src.suffix == ".json":
            kind = "json"
        else:
            kind = "nix"
    if kind == "json":
        data = json.loads(src.read_text())
        if select:
            data = {h: _select_py(c, select) for h, c in data.items()}
    else:
        if kind == "flake":
            fleet = f"(builtins.getFlake (toString {src.resolve()})).nixosConfigurations"
        else:
            fleet = f"import {src.resolve()}"
        host_filter = ""
        if hosts:
            names = " ".join(nix_string(h) for h in hosts)
            host_filter = f"fleet = builtins.intersectAttrs (builtins.listToAttrs (map (n: {{ name = n; value = null; }}) [ {names} ])) fleet0;"
        else:
            host_filter = "fleet = fleet0;"
        expr = f"""
let
  {_MINILIB}
  fleet0 = {fleet};
  {host_filter}
  ser = import {SERIALIZER} {{ maxDepth = {int(max_depth)}; }};
  pick = {_select_expr(select)};
  cfgOf = sys: if builtins.isAttrs sys && sys ? config && sys ? options then sys.config else sys;
in builtins.mapAttrs (_: sys: ser (pick (cfgOf sys))) fleet
"""
        data = _nix_eval_json(expr)
    if hosts:
        data = {h: c for h, c in data.items() if h in hosts}
    if not isinstance(data, dict):
        raise NixqlError("fleet must evaluate to an attrset of hosts")
    return data


def _select_py(cfg, select):
    out: dict = {}
    for p in select:
        segs = split_path(p)
        cur = cfg
        for s in segs:
            cur = cur.get(s) if isinstance(cur, dict) else None
        node = out
        for s in segs[:-1]:
            node = node.setdefault(s, {})
        node[segs[-1]] = cur
    return out


# --------------------------------------------------------------------------
# Database
# --------------------------------------------------------------------------
def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _register_functions(con: sqlite3.Connection):
    def f_nix(v):
        if v is None:
            return None
        try:
            return nix_literal(json.loads(v))
        except (ValueError, NixqlError):
            return None

    def f_segs(p):
        return json.dumps(split_path(p))

    def f_join(segs_json):
        return join_path(json.loads(segs_json))

    con.create_function("nix", 1, f_nix, deterministic=True)
    con.create_function("path_segs", 1, f_segs, deterministic=True)
    con.create_function("path_join", 1, f_join, deterministic=True)


def connect(db_path: str | os.PathLike, readonly: bool = False) -> sqlite3.Connection:
    if readonly:
        if not Path(db_path).exists():
            raise NixqlError(f"no database at {db_path}; run `nixql ingest` first")
        con = sqlite3.connect(f"file:{Path(db_path).resolve()}?mode=ro", uri=True,
                              isolation_level=None)
    else:
        con = sqlite3.connect(str(db_path), isolation_level=None)
        con.executescript(SCHEMA)
    con.execute("PRAGMA foreign_keys = ON")
    _register_functions(con)
    return con


# Authorizer: user SQL may read anything but only write `opts` (and temp tables).
_A = sqlite3
_WRITE = {_A.SQLITE_INSERT, _A.SQLITE_UPDATE, _A.SQLITE_DELETE}
_DENY_ALWAYS = {_A.SQLITE_TRANSACTION, _A.SQLITE_ATTACH, _A.SQLITE_DETACH}
_DDL = {
    _A.SQLITE_CREATE_TABLE, _A.SQLITE_DROP_TABLE, _A.SQLITE_CREATE_INDEX,
    _A.SQLITE_DROP_INDEX, _A.SQLITE_CREATE_TRIGGER, _A.SQLITE_DROP_TRIGGER,
    _A.SQLITE_CREATE_VIEW, _A.SQLITE_DROP_VIEW, _A.SQLITE_ALTER_TABLE,
}
_TEMP_DDL = {
    _A.SQLITE_CREATE_TEMP_TABLE, _A.SQLITE_DROP_TEMP_TABLE, _A.SQLITE_CREATE_TEMP_VIEW,
    _A.SQLITE_DROP_TEMP_VIEW, _A.SQLITE_CREATE_TEMP_INDEX, _A.SQLITE_DROP_TEMP_INDEX,
}


def _user_authorizer(action, arg1, arg2, dbname, trigger):
    if action in _DENY_ALWAYS:
        return sqlite3.SQLITE_DENY
    if action in _WRITE:
        if dbname == "temp" or arg1 == "opts" or arg1.startswith("sqlite_temp"):
            return sqlite3.SQLITE_OK
        return sqlite3.SQLITE_DENY
    if action in _DDL:
        return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_PRAGMA and arg2 is not None:  # pragma assignment
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK


def split_sql(script: str) -> list[str]:
    stmts, buf = [], ""
    for piece in script.split(";"):
        buf += piece + ";"
        if sqlite3.complete_statement(buf):
            if buf.strip(" \t\r\n;"):
                stmts.append(buf.strip())
            buf = ""
    if buf.strip(" \t\r\n;"):
        stmts.append(buf.rstrip(";").strip())
    return stmts


# --------------------------------------------------------------------------
# Ingest
# --------------------------------------------------------------------------
@dataclass
class IngestReport:
    hosts: list[str] = field(default_factory=list)
    leaves: int = 0
    upstream: list[tuple] = field(default_factory=list)  # (host, path, old, new)
    drift: list[tuple] = field(default_factory=list)  # (host, path, wanted, evaluated)


def ingest(con: sqlite3.Connection, fleet: dict[str, dict], source: str = "",
           prune: bool = False) -> IngestReport:
    """Replace `evaluated` for the given hosts and rebuild `opts` = evaluated + overrides."""
    rep = IngestReport()
    con.execute("BEGIN IMMEDIATE")
    try:
        if prune:
            gone = [r[0] for r in con.execute("SELECT name FROM hosts") if r[0] not in fleet]
            for h in gone:
                for t in ("opts", "evaluated", "overrides"):
                    con.execute(f"DELETE FROM {t} WHERE host=?", (h,))
                con.execute("DELETE FROM hosts WHERE name=?", (h,))
        for host, cfg in sorted(fleet.items()):
            rep.hosts.append(host)
            old = dict(con.execute("SELECT path, value FROM evaluated WHERE host=?", (host,)))
            con.execute(
                "INSERT INTO hosts(name, source, ingested_at) VALUES(?,?,?) "
                "ON CONFLICT(name) DO UPDATE SET source=excluded.source, ingested_at=excluded.ingested_at",
                (host, source, _now()))
            con.execute("DELETE FROM evaluated WHERE host=?", (host,))
            con.execute("DELETE FROM opts WHERE host=?", (host,))
            rows = [(host, join_path(segs), canon(v)) for segs, v in flatten(cfg)]
            rep.leaves += len(rows)
            con.executemany("INSERT INTO evaluated VALUES(?,?,?)", rows)
            new = {p: v for _, p, v in rows}
            if old:
                for p in sorted(set(old) | set(new)):
                    if old.get(p) != new.get(p):
                        rep.upstream.append((host, p, old.get(p), new.get(p)))
            con.execute("INSERT INTO opts SELECT host, path, value FROM evaluated WHERE host=?", (host,))
            con.execute(
                "INSERT INTO opts(host, path, value) SELECT host, path, value FROM overrides WHERE host=? "
                "ON CONFLICT(host, path) DO UPDATE SET value=excluded.value", (host,))
        con.execute("COMMIT")
    except BaseException:
        con.execute("ROLLBACK")
        raise
    rep.drift = [tuple(r) for r in con.execute(
        "SELECT host, path, wanted, evaluated FROM drift ORDER BY host, path")]
    return rep


# --------------------------------------------------------------------------
# Policies
# --------------------------------------------------------------------------
def load_policies(paths) -> list[tuple[str, str]]:
    out = []
    for p in paths or []:
        p = Path(p)
        files = sorted(p.glob("*.sql")) if p.is_dir() else [p]
        for f in files:
            out.append((f.stem, f.read_text()))
    return out


def run_policies(con: sqlite3.Connection, policies: list[tuple[str, str]]):
    """Each policy is a SELECT; every row it returns is a violation."""
    violations = []
    con.set_authorizer(_readonly_authorizer)
    try:
        for name, sql in policies:
            for stmt in split_sql(sql):
                try:
                    cur = con.execute(stmt)
                except sqlite3.DatabaseError as e:
                    raise NixqlError(f"policy {name}: {e}") from e
                if cur.description is None:
                    continue
                rows = cur.fetchall()
                if rows:
                    cols = [d[0] for d in cur.description]
                    violations.append((name, cols, rows))
    finally:
        con.set_authorizer(None)
    return violations


def _readonly_authorizer(action, arg1, arg2, dbname, trigger):
    if action in _WRITE or action in _DDL or action in _DENY_ALWAYS:
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK


# --------------------------------------------------------------------------
# Apply (the interesting part)
# --------------------------------------------------------------------------
@dataclass
class Change:
    host: str
    path: str
    old: str | None
    new: str | None


@dataclass
class ApplyResult:
    changeset: int | None
    changes: list[Change]
    committed: bool
    statements: list[tuple[str, int]] = field(default_factory=list)  # (sql, rowcount)
    results: list[tuple[list[str], list[tuple]]] = field(default_factory=list)

    @property
    def hosts(self):
        return sorted({c.host for c in self.changes})


_TRACK = """
CREATE TEMP TABLE IF NOT EXISTS _touched(host TEXT, path TEXT, old_value TEXT, PRIMARY KEY(host, path));
DELETE FROM _touched;
CREATE TEMP TRIGGER IF NOT EXISTS _t_ins AFTER INSERT ON main.opts BEGIN
  INSERT OR IGNORE INTO _touched VALUES(NEW.host, NEW.path, NULL); END;
CREATE TEMP TRIGGER IF NOT EXISTS _t_del AFTER DELETE ON main.opts BEGIN
  INSERT OR IGNORE INTO _touched VALUES(OLD.host, OLD.path, OLD.value); END;
CREATE TEMP TRIGGER IF NOT EXISTS _t_upd AFTER UPDATE ON main.opts BEGIN
  INSERT OR IGNORE INTO _touched VALUES(OLD.host, OLD.path, OLD.value);
  INSERT OR IGNORE INTO _touched VALUES(NEW.host, NEW.path, NULL); END;
"""

_UNTRACK = "DROP TRIGGER IF EXISTS temp._t_ins; DROP TRIGGER IF EXISTS temp._t_del; DROP TRIGGER IF EXISTS temp._t_upd;"


def _normalize_touched(con):
    # Values are JSON. Accept SQL numbers, JSONB blobs and bare (non-JSON) strings.
    con.execute("""
      UPDATE opts SET value = CASE
          WHEN typeof(value) = 'blob' THEN json(value)
          WHEN typeof(value) IN ('integer', 'real') THEN json_quote(value)
          WHEN typeof(value) = 'text' AND json_valid(value) THEN json(value)
          WHEN typeof(value) = 'text' THEN json_quote(value)
          ELSE value END
      WHERE (host, path) IN (SELECT host, path FROM _touched) AND value IS NOT NULL""")
    bad = con.execute("""SELECT host, path FROM opts WHERE value IS NULL
                         AND (host, path) IN (SELECT host, path FROM _touched)""").fetchall()
    if bad:
        raise NixqlError(f"SQL NULL is not a value; use 'null' for Nix null (e.g. {bad[0]})")


def _collect_changes(con) -> list[Change]:
    rows = con.execute("""
      SELECT t.host, t.path, t.old_value, o.value
      FROM _touched t LEFT JOIN opts o USING(host, path) ORDER BY t.host, t.path""").fetchall()
    changes = []
    for host, path, old, new in rows:
        if old is not None and new is not None and canon(json.loads(old)) == canon(json.loads(new)):
            continue
        if old is None and new is None:
            continue
        changes.append(Change(host, path, old, new))
    return changes


def _check_shape(con, changes):
    hosts = {r[0] for r in con.execute("SELECT name FROM hosts")}
    for c in changes:
        if c.host not in hosts:
            raise NixqlError(f"unknown host {c.host!r} (ingest it first)")
        split_path(c.path)  # validates syntax
        if c.new is not None:
            v = json.loads(c.new)
            nix_literal(v)  # raises on unrenderable values
            if isinstance(v, dict) and v:
                raise NixqlError(
                    f"{c.host}:{c.path}: set leaves, not attrsets (got an attrset value); "
                    "insert one row per leaf instead")
        elif con.execute("SELECT 1 FROM evaluated WHERE host=? AND path=?",
                         (c.host, c.path)).fetchone():
            raise NixqlError(
                f"{c.host}:{c.path} is defined by Nix; it cannot be deleted, only set "
                "(e.g. to null, false or [])")


def _record(con, changes, message, sql, reverts=None) -> int:
    cur = con.execute("INSERT INTO changesets(at, message, sql, reverts) VALUES(?,?,?,?)",
                      (_now(), message, sql, reverts))
    cs = cur.lastrowid
    for c in changes:
        prev = con.execute("SELECT value FROM overrides WHERE host=? AND path=?",
                           (c.host, c.path)).fetchone()
        con.execute("INSERT INTO changes VALUES(?,?,?,?,?,?,?)",
                    (cs, c.host, c.path, c.old, c.new, int(prev is not None),
                     prev[0] if prev else None))
    return cs


def _update_overrides(con, changes, cs):
    for c in changes:
        if c.new is None:
            con.execute("DELETE FROM overrides WHERE host=? AND path=?", (c.host, c.path))
        else:
            con.execute(
                "INSERT INTO overrides VALUES(?,?,?,?) ON CONFLICT(host, path) "
                "DO UPDATE SET value=excluded.value, changeset=excluded.changeset",
                (c.host, c.path, c.new, cs))


def apply(con: sqlite3.Connection, sql: str, message: str = "", policies=(),
          dry_run: bool = False, out_dir: str | None = None,
          priority: str = "lib.mkForce") -> ApplyResult:
    """Run user SQL against `opts` in ONE transaction, gate with policies, record a
    changeset, update overrides and (optionally) emit Nix modules. All or nothing."""
    stmts = split_sql(sql)
    if not stmts:
        raise NixqlError("no SQL given")
    con.executescript(_TRACK)
    con.execute("BEGIN IMMEDIATE")
    staged = None
    res = ApplyResult(None, [], False)
    try:
        con.set_authorizer(_user_authorizer)
        try:
            for s in stmts:
                cur = con.execute(s)
                if cur.description:
                    res.results.append(([d[0] for d in cur.description], cur.fetchall()))
                res.statements.append((s, cur.rowcount))
        except sqlite3.DatabaseError as e:
            raise NixqlError(f"SQL error: {e}") from e
        finally:
            con.set_authorizer(None)
        _normalize_touched(con)
        res.changes = _collect_changes(con)
        _check_shape(con, res.changes)
        violations = run_policies(con, list(policies))
        if violations:
            raise PolicyViolation(violations)
        if dry_run or not res.changes:
            con.execute("ROLLBACK")
            return res
        cs = _record(con, res.changes, message, sql)
        _update_overrides(con, res.changes, cs)
        res.changeset = cs
        if out_dir:
            staged = stage_emit(con, out_dir, priority)
        con.execute("COMMIT")
        res.committed = True
    except BaseException:
        if con.in_transaction:
            con.execute("ROLLBACK")
        if staged:
            shutil.rmtree(staged, ignore_errors=True)
        raise
    finally:
        con.executescript(_UNTRACK)
    if staged:
        swap_in(staged, out_dir)
    return res


def revert(con: sqlite3.Connection, cs_id: int, policies=(), force: bool = False,
           dry_run: bool = False, out_dir: str | None = None,
           priority: str = "lib.mkForce") -> ApplyResult:
    """Undo a changeset as a new changeset. Refuses if a later change touched the same
    keys (unless force)."""
    rows = con.execute("SELECT host, path, old_value, new_value, had_override, old_override "
                       "FROM changes WHERE changeset=?", (cs_id,)).fetchall()
    if not rows:
        raise NixqlError(f"changeset {cs_id} not found or empty")
    con.execute("BEGIN IMMEDIATE")
    staged = None
    res = ApplyResult(None, [], False)
    try:
        conflicts = []
        for host, path, old, new, had_ov, old_ov in rows:
            cur = con.execute("SELECT value FROM opts WHERE host=? AND path=?", (host, path)).fetchone()
            cur = cur[0] if cur else None
            if cur != new and not force:
                conflicts.append((host, path, new, cur))
            if old is None:
                con.execute("DELETE FROM opts WHERE host=? AND path=?", (host, path))
            else:
                con.execute("INSERT INTO opts VALUES(?,?,?) ON CONFLICT(host,path) "
                            "DO UPDATE SET value=excluded.value", (host, path, old))
            res.changes.append(Change(host, path, cur, old))
        if conflicts:
            raise NixqlError("revert conflicts (changed again since); use --force:\n" + "\n".join(
                f"  {h}:{p}: expected {n}, now {c}" for h, p, n, c in conflicts))
        violations = run_policies(con, list(policies))
        if violations:
            raise PolicyViolation(violations)
        if dry_run:
            con.execute("ROLLBACK")
            return res
        cs = _record(con, res.changes, f"revert changeset {cs_id}", None, reverts=cs_id)
        for host, path, old, new, had_ov, old_ov in rows:
            if had_ov:
                con.execute("INSERT INTO overrides VALUES(?,?,?,?) ON CONFLICT(host,path) "
                            "DO UPDATE SET value=excluded.value, changeset=excluded.changeset",
                            (host, path, old_ov, cs))
            else:
                con.execute("DELETE FROM overrides WHERE host=? AND path=?", (host, path))
        res.changeset = cs
        if out_dir:
            staged = stage_emit(con, out_dir, priority)
        con.execute("COMMIT")
        res.committed = True
    except BaseException:
        if con.in_transaction:
            con.execute("ROLLBACK")
        if staged:
            shutil.rmtree(staged, ignore_errors=True)
        raise
    if staged:
        swap_in(staged, out_dir)
    return res


# --------------------------------------------------------------------------
# Emit
# --------------------------------------------------------------------------
def render_host(con, host: str, priority: str = "lib.mkForce") -> str:
    rows = con.execute("""
      SELECT ov.path, ov.value, ov.changeset, cs.message FROM overrides ov
      LEFT JOIN changesets cs ON cs.id = ov.changeset
      WHERE ov.host=? ORDER BY ov.path""", (host,)).fetchall()
    paths = [split_path(p) for p, *_ in rows]
    for i, a in enumerate(paths):
        for b in paths:
            if len(b) > len(a) and b[:len(a)] == a:
                raise NixqlError(f"{host}: override {join_path(a)} is a prefix of {join_path(b)}")
    lines = [
        f"# Generated by nixql for host {host!s}. Do not edit; change the fleet DB instead.",
        "{ lib, ... }:",
        "{",
    ]
    last_cs = object()
    for path, value, cs, msg in rows:
        if cs != last_cs:
            note = f"changeset {cs}" + (f": {msg}" if msg else "")
            lines.append(f"  # {note.splitlines()[0] if note else ''}")
            last_cs = cs
        lines.append(f"  {path} = {priority} {_paren(nix_literal(json.loads(value), 1))};")
    lines.append("}")
    return "\n".join(lines) + "\n"


def _paren(lit: str) -> str:
    return lit if re.match(r'^[\[{"(]|^[\w.-]+$', lit) else f"({lit})"


def stage_emit(con, out_dir: str, priority: str = "lib.mkForce") -> str:
    out = Path(out_dir).resolve()
    if out.exists() and not (out / MARKER_FILE).exists():
        raise NixqlError(f"{out} exists and was not generated by nixql; refusing to replace it")
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=f".{out.name}.new-", dir=out.parent))
    hosts = [r[0] for r in con.execute("SELECT name FROM hosts ORDER BY name")]
    for h in hosts:
        (tmp / f"{_fname(h)}.nix").write_text(render_host(con, h, priority))
    entries = "".join(f"  {quote_seg(h)} = ./{_fname(h)}.nix;\n" for h in hosts)
    (tmp / "default.nix").write_text(
        "# Generated by nixql: host name -> override module.\n{\n" + entries + "}\n")
    (tmp / MARKER_FILE).write_text("This directory is generated by nixql and replaced wholesale.\n")
    return str(tmp)


def _fname(host: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", host)


def swap_in(staged: str, out_dir: str):
    """Replace out_dir with staged with two renames (no window with a half-written dir)."""
    out = Path(out_dir).resolve()
    old = None
    if out.exists():
        old = out.parent / f".{out.name}.old-{os.getpid()}"
        os.rename(out, old)
    os.rename(staged, out)
    if old:
        shutil.rmtree(old, ignore_errors=True)


def emit(con, out_dir: str, priority: str = "lib.mkForce"):
    swap_in(stage_emit(con, out_dir, priority), out_dir)
