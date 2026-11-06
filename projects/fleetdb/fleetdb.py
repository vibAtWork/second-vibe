#!/usr/bin/env python3
"""fleetdb: the fleet's source of truth is a relational SQLite database; Nix reads it.

Changes are SQL run in one transaction. Before commit: foreign keys, CHECKs and the
`violations` view must all be clean. On commit, the `export` view is written to
fleet.json (atomically), which NixOS hosts read via module.nix. Every row change is
audited and any transaction can be undone.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCHEMA = (HERE / "schema.sql").read_text()
DATA_TABLES = ["hosts", "users", "ssh_keys", "access", "services"]
PROTECTED = {"audit", "txns"}


class FleetError(Exception):
    pass


class Violations(FleetError):
    def __init__(self, rows):
        self.rows = rows
        super().__init__(f"{len(rows)} invariant violation(s); transaction rolled back")


# ---------------------------------------------------------------- db setup
def _audit_triggers(con) -> str:
    out = []
    for t in DATA_TABLES:
        cols = [r[1] for r in con.execute(f"PRAGMA table_info({t})")]
        def obj(prefix):
            parts = [f"'rowid', {prefix}.rowid"] + [f"'{c}', {prefix}.{c}" for c in cols]
            return "json_object(" + ", ".join(parts) + ")"
        txn = "(SELECT max(id) FROM txns)"
        out.append(f"""
CREATE TRIGGER IF NOT EXISTS audit_{t}_ins AFTER INSERT ON {t} BEGIN
  INSERT INTO audit(txn, tbl, op, new) VALUES({txn}, '{t}', 'INSERT', {obj('NEW')}); END;
CREATE TRIGGER IF NOT EXISTS audit_{t}_upd AFTER UPDATE ON {t} BEGIN
  INSERT INTO audit(txn, tbl, op, old, new) VALUES({txn}, '{t}', 'UPDATE', {obj('OLD')}, {obj('NEW')}); END;
CREATE TRIGGER IF NOT EXISTS audit_{t}_del AFTER DELETE ON {t} BEGIN
  INSERT INTO audit(txn, tbl, op, old) VALUES({txn}, '{t}', 'DELETE', {obj('OLD')}); END;""")
    return "\n".join(out)


def connect(path, readonly=False) -> sqlite3.Connection:
    if readonly:
        if not Path(path).exists():
            raise FleetError(f"no database at {path}; run `fleetdb init`")
        con = sqlite3.connect(f"file:{Path(path).resolve()}?mode=ro", uri=True, isolation_level=None)
    else:
        con = sqlite3.connect(str(path), isolation_level=None)
        con.executescript(SCHEMA)
        con.executescript(_audit_triggers(con))
    con.execute("PRAGMA foreign_keys = ON")
    return con


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


def _authorizer(action, arg1, arg2, dbname, trigger):
    if action in (sqlite3.SQLITE_TRANSACTION, sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH):
        return sqlite3.SQLITE_DENY
    if action in (sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE):
        # audit triggers themselves write to `audit`: allow when inside a trigger.
        if arg1 in PROTECTED and trigger is None:
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK
    if action in (sqlite3.SQLITE_CREATE_TABLE, sqlite3.SQLITE_DROP_TABLE, sqlite3.SQLITE_ALTER_TABLE,
                  sqlite3.SQLITE_CREATE_TRIGGER, sqlite3.SQLITE_DROP_TRIGGER,
                  sqlite3.SQLITE_CREATE_VIEW, sqlite3.SQLITE_DROP_VIEW,
                  sqlite3.SQLITE_CREATE_INDEX, sqlite3.SQLITE_DROP_INDEX):
        return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_PRAGMA and arg1 not in ("defer_foreign_keys",) and arg2 is not None:
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK


# ---------------------------------------------------------------- export
def export_doc(con) -> dict:
    hosts = {h: json.loads(c) for h, c in con.execute("SELECT host, config FROM export ORDER BY host")}
    body = json.dumps(hosts, sort_keys=True, separators=(",", ":"))
    return {"generatedBy": "fleetdb", "sha256": hashlib.sha256(body.encode()).hexdigest(),
            "hosts": hosts}


def write_export(doc: dict, out: str):
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{out.name}.", dir=out.parent)
    with os.fdopen(fd, "w") as f:
        json.dump(doc, f, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(tmp, out)


def _leaves(v, prefix=""):
    if isinstance(v, dict) and v:
        for k, x in v.items():
            yield from _leaves(x, f"{prefix}.{k}" if prefix else k)
    else:
        yield prefix, v


def diff_docs(old: dict | None, new: dict) -> list[tuple[str, str, str, object, object]]:
    """[(host, kind, path, old, new)] where kind is + - ~ (host-level: '+host', '-host')."""
    oh, nh = (old or {}).get("hosts", {}), new.get("hosts", {})
    out = []
    for h in sorted(set(oh) | set(nh)):
        if h not in oh:
            out.append((h, "+host", "", None, None))
            continue
        if h not in nh:
            out.append((h, "-host", "", None, None))
            continue
        a, b = dict(_leaves(oh[h])), dict(_leaves(nh[h]))
        for p in sorted(set(a) | set(b)):
            if p not in a:
                out.append((h, "+", p, None, b[p]))
            elif p not in b:
                out.append((h, "-", p, a[p], None))
            elif a[p] != b[p]:
                out.append((h, "~", p, a[p], b[p]))
    return out


def read_export(path) -> dict | None:
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        return None


# ---------------------------------------------------------------- transactions
def _check(con):
    fk = con.execute("PRAGMA foreign_key_check").fetchall()
    if fk:
        raise Violations([("foreign key", f"{t} rowid {r} -> {p}") for t, r, p, _ in fk])
    v = con.execute("SELECT rule, subject FROM violations").fetchall()
    if v:
        raise Violations(v)


def transact(con, sql: str | None, message: str, out: str | None, dry_run=False, fn=None):
    """Run SQL (or fn(con)) in one transaction; check invariants; export. Returns
    (txn_id or None, diff, results)."""
    before = export_doc(con)
    results = []
    con.execute("BEGIN IMMEDIATE")
    try:
        con.execute("PRAGMA defer_foreign_keys = ON")  # allow temporarily-inconsistent steps
        txn = con.execute("INSERT INTO txns(message) VALUES(?)", (message,)).lastrowid
        if fn:
            fn(con)
        else:
            con.set_authorizer(_authorizer)
            try:
                for s in split_sql(sql):
                    cur = con.execute(s)
                    if cur.description:
                        results.append(([d[0] for d in cur.description], cur.fetchall()))
            except sqlite3.DatabaseError as e:
                raise FleetError(f"SQL error: {e}") from e
            finally:
                con.set_authorizer(None)
        _check(con)
        after = export_doc(con)
        diff = diff_docs(before, after)
        if dry_run or not con.execute("SELECT 1 FROM audit WHERE txn=?", (txn,)).fetchone():
            con.execute("ROLLBACK")
            return None, diff, results
        con.execute("UPDATE txns SET export_sha=? WHERE id=?", (after["sha256"], txn))
        con.execute("COMMIT")
    except sqlite3.IntegrityError as e:
        con.execute("ROLLBACK")
        raise FleetError(f"constraint failed: {e}") from e
    except BaseException:
        if con.in_transaction:
            con.execute("ROLLBACK")
        raise
    if out:
        write_export(after, out)
    return txn, diff, results


def undo(con, txn_id: int, out: str | None, dry_run=False):
    rows = con.execute("SELECT tbl, op, old, new FROM audit WHERE txn=? ORDER BY id DESC",
                       (txn_id,)).fetchall()
    if not rows:
        raise FleetError(f"transaction {txn_id} has no recorded changes")

    def inverse(c):
        for tbl, op, old, new in rows:
            if tbl not in DATA_TABLES:
                raise FleetError(f"unexpected table {tbl!r} in audit")
            o, n = (json.loads(old) if old else None), (json.loads(new) if new else None)
            if op == "INSERT":
                c.execute(f"DELETE FROM {tbl} WHERE rowid=?", (n["rowid"],))
            elif op == "DELETE":
                cols = list(o)
                c.execute(f"INSERT INTO {tbl}({', '.join(cols)}) VALUES({', '.join('?' * len(cols))})",
                          [o[k] for k in cols])
            else:
                cols = [k for k in o if k != "rowid"]
                c.execute(f"UPDATE {tbl} SET {', '.join(f'{k}=?' for k in cols)} WHERE rowid=?",
                          [o[k] for k in cols] + [n["rowid"]])
    return transact(con, None, f"undo {txn_id}", out, dry_run=dry_run, fn=inverse)


# ---------------------------------------------------------------- CLI
def _table(cols, rows, out=sys.stdout):
    s = [["NULL" if v is None else str(v) for v in r] for r in rows]
    w = [max([len(c)] + [len(r[i]) for r in s]) for i, c in enumerate(cols)]
    print("  ".join(c.ljust(x) for c, x in zip(cols, w)), file=out)
    print("  ".join("-" * x for x in w), file=out)
    for r in s:
        print("  ".join(c.ljust(x) for c, x in zip(r, w)).rstrip(), file=out)


def _show_diff(diff):
    if not diff:
        print("no change to any host's config")
        return
    for h, k, p, o, n in diff:
        j = lambda v: json.dumps(v)  # noqa: E731
        if k == "+host":
            print(f"  + {h} (new host)")
        elif k == "-host":
            print(f"  - {h} (removed)")
        elif k == "+":
            print(f"  {h:<10} + {p} = {j(n)}")
        elif k == "-":
            print(f"  {h:<10} - {p} (was {j(o)})")
        else:
            print(f"  {h:<10} ~ {p}: {j(o)} -> {j(n)}")
    print(f"  ({len(diff)} change(s) across {len({d[0] for d in diff})} host(s))")


def _sql(args):
    parts = [sys.stdin.read() if f == "-" else open(f).read() for f in (args.file or [])]
    if args.sql:
        parts.append(args.sql)
    if not parts:
        raise FleetError("give SQL as an argument or with -f FILE")
    return ";\n".join(p.rstrip().rstrip(";") for p in parts)


def main(argv=None):
    p = argparse.ArgumentParser(prog="fleetdb", description=__doc__.split("\n")[0])
    p.add_argument("--db", default=os.environ.get("FLEETDB", "fleet.sqlite"))
    p.add_argument("--out", default=os.environ.get("FLEETDB_OUT", "fleet.json"),
                   help="export file read by Nix (default fleet.json)")
    sub = p.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("init", help="create the database (optionally run seed SQL)")
    sp.add_argument("-f", "--file", action="append")
    sp.add_argument("sql", nargs="?")
    for name in ("sql", "plan"):
        sp = sub.add_parser(name, help="change the fleet in one transaction" if name == "sql"
                            else "dry run: show per-host config diff, roll back")
        sp.add_argument("sql", nargs="?")
        sp.add_argument("-f", "--file", action="append")
        sp.add_argument("-m", "--message", default="")
    sp = sub.add_parser("q", help="read-only query")
    sp.add_argument("sql", nargs="?")
    sp.add_argument("-f", "--file", action="append")
    sp = sub.add_parser("export", help="rewrite the export file from the DB")
    sp = sub.add_parser("status", help="is the export file in sync with the DB?")
    sp = sub.add_parser("log", help="transaction history")
    sp.add_argument("-v", "--verbose", action="store_true")
    sp = sub.add_parser("undo", help="revert a transaction (as a new transaction)")
    sp.add_argument("txn", type=int)
    sp.add_argument("-n", "--dry-run", action="store_true")
    sp = sub.add_parser("show", help="print one host's exported config")
    sp.add_argument("host")
    args = p.parse_args(argv)

    try:
        if args.cmd == "init":
            con = connect(args.db)
            if args.file or args.sql:
                txn, diff, _ = transact(con, _sql(args), "init/seed", args.out)
                _show_diff(diff)
            else:
                write_export(export_doc(con), args.out)
            print(f"✓ {args.db} ready; export in {args.out}")
        elif args.cmd in ("sql", "plan"):
            con = connect(args.db)
            txn, diff, results = transact(con, _sql(args), args.message, args.out,
                                          dry_run=args.cmd == "plan")
            for cols, rows in results:
                _table(cols, rows)
            _show_diff(diff)
            if txn:
                print(f"✓ committed transaction {txn}; wrote {args.out}")
            elif diff:
                print("(plan only: rolled back)")
        elif args.cmd == "q":
            con = connect(args.db, readonly=True)
            for s in split_sql(_sql(args)):
                cur = con.execute(s)
                if cur.description:
                    _table([d[0] for d in cur.description], cur.fetchall())
        elif args.cmd == "export":
            write_export(export_doc(connect(args.db)), args.out)
            print(f"wrote {args.out}")
        elif args.cmd == "status":
            con = connect(args.db, readonly=True)
            d = diff_docs(read_export(args.out), export_doc(con))
            if d:
                print(f"{args.out} is out of date with {args.db}:")
                _show_diff(d)
                return 1
            print(f"✓ {args.out} matches {args.db}")
        elif args.cmd == "log":
            con = connect(args.db, readonly=True)
            for tid, at, msg in con.execute("SELECT id, at, message FROM txns t WHERE EXISTS "
                                            "(SELECT 1 FROM audit a WHERE a.txn=t.id) ORDER BY id DESC"):
                n = con.execute("SELECT count(*) FROM audit WHERE txn=?", (tid,)).fetchone()[0]
                print(f"#{tid}  {at}  {msg or '(no message)'}  [{n} row change(s)]")
                if args.verbose:
                    for tbl, op, old, new in con.execute(
                            "SELECT tbl, op, old, new FROM audit WHERE txn=? ORDER BY id", (tid,)):
                        print(f"      {op:<6} {tbl:<9} {new or old}")
        elif args.cmd == "undo":
            con = connect(args.db)
            txn, diff, _ = undo(con, args.txn, args.out, dry_run=args.dry_run)
            _show_diff(diff)
            if txn:
                print(f"✓ committed transaction {txn} (undoes {args.txn}); wrote {args.out}")
        elif args.cmd == "show":
            con = connect(args.db, readonly=True)
            r = con.execute("SELECT config FROM export WHERE host=?", (args.host,)).fetchone()
            if not r:
                raise FleetError(f"no host {args.host!r}")
            print(json.dumps(json.loads(r[0]), indent=2))
    except Violations as e:
        print(f"✗ {e}", file=sys.stderr)
        _table(["rule", "subject"], e.rows, out=sys.stderr)
        return 3
    except (FleetError, sqlite3.Error) as e:
        print(f"fleetdb: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
