"""nixql command line. Run `python3 -m nixql --help` (or ./bin/nixql)."""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys

from . import core
from .core import NixqlError, PolicyViolation

DEFAULT_DB = os.environ.get("NIXQL_DB", "fleet.db")


def _table(cols, rows, out=sys.stdout, limit_width=60):
    def cell(v):
        s = "NULL" if v is None else str(v)
        return s if len(s) <= limit_width else s[: limit_width - 1] + "…"
    srows = [[cell(v) for v in r] for r in rows]
    widths = [max([len(c)] + [len(r[i]) for r in srows]) for i, c in enumerate(cols)]
    print("  ".join(c.ljust(w) for c, w in zip(cols, widths)), file=out)
    print("  ".join("-" * w for w in widths), file=out)
    for r in srows:
        print("  ".join(c.ljust(w) for c, w in zip(r, widths)).rstrip(), file=out)
    print(f"({len(rows)} row{'s' if len(rows) != 1 else ''})", file=out)


def _print_result(cols, rows, fmt):
    if fmt == "json":
        print(json.dumps([dict(zip(cols, r)) for r in rows], indent=2))
    elif fmt == "csv":
        w = csv.writer(sys.stdout)
        w.writerow(cols)
        w.writerows(rows)
    else:
        _table(cols, rows)


def _sql_arg(args):
    parts = []
    if args.file:
        for f in args.file:
            parts.append(sys.stdin.read() if f == "-" else open(f).read())
    if args.sql:
        parts.append(args.sql)
    if not parts:
        raise NixqlError("give SQL as an argument or with -f FILE")
    return ";\n".join(p.rstrip().rstrip(";") for p in parts)


def _policies(args):
    paths = list(args.policy or [])
    if not args.no_default_policies and os.path.isdir("policies"):
        paths.insert(0, "policies")
    pols = core.load_policies(paths)
    for i, a in enumerate(args.check or []):
        pols.append((f"--check#{i + 1}", a))
    return pols


def _short(v, n=70):
    if v is None:
        return "∅"
    return v if len(v) <= n else v[: n - 1] + "…"


def _show_changes(changes):
    if not changes:
        print("no changes")
        return
    for c in changes:
        old = _short(c.old)
        new = "∅ (removed)" if c.new is None else _short(c.new)
        print(f"  {c.host:<12} {c.path} : {old} -> {new}")


def _show_violations(e: PolicyViolation):
    print(f"✗ {e}", file=sys.stderr)
    for name, cols, rows in e.violations:
        print(f"\npolicy {name}:", file=sys.stderr)
        _table(cols, rows, out=sys.stderr)


def cmd_ingest(args):
    con = core.connect(args.db)
    fleet = core.eval_fleet(args.source, kind=args.kind, select=args.select,
                            max_depth=args.max_depth, hosts=args.hosts)
    rep = core.ingest(con, fleet, source=args.source, prune=args.prune)
    print(f"ingested {len(rep.hosts)} host(s), {rep.leaves} leaves: {', '.join(rep.hosts)}")
    if rep.upstream:
        print(f"\nupstream changes since last ingest ({len(rep.upstream)}):")
        for h, p, o, n in rep.upstream[: args.show]:
            print(f"  {h:<12} {p} : {_short(o)} -> {_short(n)}")
        if len(rep.upstream) > args.show:
            print(f"  … {len(rep.upstream) - args.show} more")
    if rep.drift:
        print(f"\ndrift: {len(rep.drift)} override(s) not reflected in evaluation "
              "(not imported or not deployed yet):")
        for h, p, w, e in rep.drift[: args.show]:
            print(f"  {h:<12} {p} : wanted {_short(w)}, evaluates to {_short(e)}")


def cmd_query(args):
    con = core.connect(args.db, readonly=True)
    sql = _sql_arg(args)
    for stmt in core.split_sql(sql):
        try:
            cur = con.execute(stmt)
        except Exception as e:
            raise NixqlError(f"SQL error: {e}") from e
        if cur.description:
            _print_result([d[0] for d in cur.description], cur.fetchall(), args.format)


def cmd_apply(args):
    con = core.connect(args.db)
    sql = _sql_arg(args)
    try:
        res = core.apply(con, sql, message=args.message or "", policies=_policies(args),
                         dry_run=args.dry_run, out_dir=None if args.dry_run else args.out,
                         priority=args.priority)
    except PolicyViolation as e:
        _show_violations(e)
        return 3
    for cols, rows in res.results:
        _table(cols, rows)
    if args.hosts_only:
        print("\n".join(res.hosts))
        return 0
    print(f"{'plan' if args.dry_run else 'changes'} ({len(res.changes)} across {len(res.hosts)} host(s)):")
    _show_changes(res.changes)
    if res.committed:
        print(f"\n✓ committed changeset {res.changeset}; wrote {args.out}/")
        print(f"  changed hosts: {' '.join(res.hosts)}")
    elif args.dry_run and res.changes:
        print("\n(dry run: rolled back)")
    return 0


def cmd_revert(args):
    con = core.connect(args.db)
    try:
        res = core.revert(con, args.changeset, policies=_policies(args), force=args.force,
                          dry_run=args.dry_run, out_dir=None if args.dry_run else args.out,
                          priority=args.priority)
    except PolicyViolation as e:
        _show_violations(e)
        return 3
    _show_changes(res.changes)
    if res.committed:
        print(f"\n✓ committed changeset {res.changeset} (reverts {args.changeset}); wrote {args.out}/")
    return 0


def cmd_check(args):
    con = core.connect(args.db, readonly=True)
    v = core.run_policies(con, _policies(args))
    if v:
        e = PolicyViolation(v)
        e.args = (f"{sum(len(r) for _, _, r in v)} policy violation(s)",)
        _show_violations(e)
        return 3
    print("✓ all policies pass")
    return 0


def cmd_emit(args):
    con = core.connect(args.db)
    core.emit(con, args.out, args.priority)
    print(f"wrote {args.out}/")


def cmd_log(args):
    con = core.connect(args.db, readonly=True)
    for cs, at, msg, rev in con.execute(
            "SELECT id, at, message, reverts FROM changesets ORDER BY id DESC LIMIT ?", (args.n,)):
        n = con.execute("SELECT count(*), count(DISTINCT host) FROM changes WHERE changeset=?", (cs,)).fetchone()
        print(f"#{cs}  {at}  {msg or '(no message)'}  [{n[0]} change(s), {n[1]} host(s)]")
        if args.verbose:
            for h, p, o, nv in con.execute(
                    "SELECT host, path, old_value, new_value FROM changes WHERE changeset=?", (cs,)):
                print(f"      {h:<12} {p} : {_short(o)} -> {_short(nv)}")


def cmd_status(args):
    con = core.connect(args.db, readonly=True)
    hosts = con.execute("SELECT count(*) FROM hosts").fetchone()[0]
    leaves = con.execute("SELECT count(*) FROM opts").fetchone()[0]
    ovs = con.execute("SELECT count(*), count(DISTINCT host) FROM overrides").fetchone()
    print(f"{hosts} host(s), {leaves} option leaves, {ovs[0]} override(s) on {ovs[1]} host(s)")
    drift = con.execute("SELECT host, path, wanted, evaluated FROM drift ORDER BY 1, 2").fetchall()
    if drift:
        print(f"\nnot yet reflected in evaluation ({len(drift)}):")
        _table(["host", "path", "wanted", "evaluated"], drift)
    else:
        print("no drift: every override is reflected in the last evaluation")


def cmd_show(args):
    con = core.connect(args.db, readonly=True)
    print(core.render_host(con, args.host, args.priority), end="")


def build_parser():
    p = argparse.ArgumentParser(prog="nixql", description=(
        "Evaluated Nix config in SQLite. Query the fleet with SQL; change it with SQL "
        "transactions gated by policies; get per-host Nix override modules out."))
    p.add_argument("--db", default=DEFAULT_DB, help="database file (default: $NIXQL_DB or fleet.db)")
    sub = p.add_subparsers(dest="cmd", required=True)

    def emit_opts(sp):
        sp.add_argument("--out", default="nixql-overrides", help="override module dir")
        sp.add_argument("--priority", default="lib.mkForce",
                        help="priority wrapper for emitted values (e.g. 'lib.mkOverride 60')")

    def pol_opts(sp):
        sp.add_argument("--policy", action="append", help="policy .sql file or dir (repeatable)")
        sp.add_argument("--check", action="append", help="inline policy SELECT (repeatable)")
        sp.add_argument("--no-default-policies", action="store_true",
                        help="don't auto-load ./policies/*.sql")

    def sql_opts(sp):
        sp.add_argument("sql", nargs="?", help="SQL text")
        sp.add_argument("-f", "--file", action="append", help="read SQL from file ('-' = stdin)")

    sp = sub.add_parser("ingest", help="evaluate a fleet and load it")
    sp.add_argument("source", help="fleet .nix file, .json file, or flake dir")
    sp.add_argument("--kind", choices=["auto", "nix", "json", "flake"], default="auto")
    sp.add_argument("--select", type=lambda s: [x for x in s.split(",") if x],
                    help="comma-separated attribute paths to keep, e.g. services.openssh,networking.firewall")
    sp.add_argument("--hosts", type=lambda s: s.split(","), help="only these hosts")
    sp.add_argument("--max-depth", type=int, default=16)
    sp.add_argument("--prune", action="store_true", help="drop hosts no longer in the source")
    sp.add_argument("--show", type=int, default=20, help="max rows of upstream/drift to print")
    sp.set_defaults(fn=cmd_ingest)

    sp = sub.add_parser("query", aliases=["q"], help="read-only SQL")
    sql_opts(sp)
    sp.add_argument("--format", choices=["table", "json", "csv"], default="table")
    sp.set_defaults(fn=cmd_query)

    sp = sub.add_parser("apply", help="change the fleet with SQL in one transaction")
    sql_opts(sp)
    sp.add_argument("-m", "--message")
    sp.add_argument("-n", "--dry-run", action="store_true", help="show the plan, roll back")
    sp.add_argument("--hosts-only", action="store_true", help="print only changed host names")
    pol_opts(sp)
    emit_opts(sp)
    sp.set_defaults(fn=cmd_apply)

    sp = sub.add_parser("revert", help="undo a changeset (as a new changeset)")
    sp.add_argument("changeset", type=int)
    sp.add_argument("--force", action="store_true")
    sp.add_argument("-n", "--dry-run", action="store_true")
    pol_opts(sp)
    emit_opts(sp)
    sp.set_defaults(fn=cmd_revert)

    sp = sub.add_parser("check", help="run policies against current desired state")
    pol_opts(sp)
    sp.set_defaults(fn=cmd_check)

    sp = sub.add_parser("emit", help="(re)write override modules from the DB")
    emit_opts(sp)
    sp.set_defaults(fn=cmd_emit)

    sp = sub.add_parser("show", help="print the override module for one host")
    sp.add_argument("host")
    sp.add_argument("--priority", default="lib.mkForce")
    sp.set_defaults(fn=cmd_show)

    sp = sub.add_parser("log", help="changeset history")
    sp.add_argument("-n", type=int, default=20)
    sp.add_argument("-v", "--verbose", action="store_true")
    sp.set_defaults(fn=cmd_log)

    sp = sub.add_parser("status", help="overrides and drift summary")
    sp.set_defaults(fn=cmd_status)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return args.fn(args) or 0
    except NixqlError as e:
        print(f"nixql: {e}", file=sys.stderr)
        return 2
    except BrokenPipeError:  # e.g. `nixql q ... | head`
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        return 0


if __name__ == "__main__":
    sys.exit(main())
