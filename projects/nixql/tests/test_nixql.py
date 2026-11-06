import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from nixql import core  # noqa: E402
from nixql.core import NixqlError, PolicyViolation  # noqa: E402

HAVE_NIX = shutil.which("nix") is not None

FLEET = {
    "web1": {"networking": {"domain": "prod", "firewall": {"allowedTCPPorts": [22, 80]}},
             "services": {"openssh": {"ports": [22], "settings": {"PasswordAuthentication": True}}},
             "users": {"users": {"bob.smith": {"isNormalUser": True}}}},
    "db1": {"networking": {"domain": "prod", "firewall": {"allowedTCPPorts": [22]}},
            "services": {"openssh": {"ports": [22], "settings": {"PasswordAuthentication": True}}}},
    "dev1": {"networking": {"domain": "dev", "firewall": {"allowedTCPPorts": [22]}},
             "services": {"openssh": {"ports": [22], "settings": {"PasswordAuthentication": True}}}},
}

SSH_FW_POLICY = ("ssh_fw", """
SELECT p.host, port.value FROM opts p, json_each(p.value) port
JOIN opts fw ON fw.host = p.host AND fw.path = 'networking.firewall.allowedTCPPorts'
WHERE p.path = 'services.openssh.ports'
  AND port.value NOT IN (SELECT value FROM json_each(fw.value))""")


def val(con, host, path, table="opts"):
    r = con.execute(f"SELECT value FROM {table} WHERE host=? AND path=?", (host, path)).fetchone()
    return None if r is None else json.loads(r[0])


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.con = core.connect(self.tmp / "f.db")
        core.ingest(self.con, json.loads(json.dumps(FLEET)))
        self.out = str(self.tmp / "ov")

    def tearDown(self):
        self.con.close()
        shutil.rmtree(self.tmp)


class TestPaths(unittest.TestCase):
    def test_roundtrip(self):
        for segs in (["a", "b"], ["users", "users", "bob.smith", "shell"], ["x", "with space"],
                     ["a", 'q"uote'], ["let", "in"], ["fileSystems", "/", "device"]):
            self.assertEqual(core.split_path(core.join_path(segs)), segs)

    def test_quoting(self):
        self.assertEqual(core.join_path(["users", "users", "bob.smith"]), 'users.users."bob.smith"')
        self.assertEqual(core.join_path(["boot", "kernel-params"]), "boot.kernel-params")

    def test_bad(self):
        for p in ("", "a..b", "a.", '"unterminated'):
            with self.assertRaises(NixqlError):
                core.split_path(p)


class TestLiteral(unittest.TestCase):
    def test_values(self):
        self.assertEqual(core.nix_literal([1, "a", True, None]), '[ 1 "a" true null ]')
        self.assertEqual(core.nix_literal(-3), "(-3)")
        self.assertEqual(core.nix_literal("${x}\n\""), '"\\${x}\\n\\""')
        self.assertEqual(core.nix_literal({}), "{ }")
        with self.assertRaises(NixqlError):
            core.nix_literal({"__nixql": "function"})

    @unittest.skipUnless(HAVE_NIX, "nix not installed")
    def test_literal_parses_in_nix(self):
        v = {"s": "a\"b${c}\\d\ne", "l": [1, -2, 1.5, None, False], "n": {"x-y": {}, "if": []}}
        out = subprocess.run(["nix", "eval", "--json", "--expr", core.nix_literal(v)],
                             capture_output=True, text=True, check=True).stdout
        self.assertEqual(json.loads(out), v)


class TestIngest(Base):
    def test_flatten(self):
        self.assertEqual(val(self.con, "web1", 'users.users."bob.smith".isNormalUser'), True)
        self.assertEqual(val(self.con, "db1", "services.openssh.ports"), [22])

    def test_upstream_diff(self):
        f = json.loads(json.dumps(FLEET))
        f["db1"]["services"]["openssh"]["ports"] = [23]
        rep = core.ingest(self.con, f)
        self.assertEqual(rep.upstream, [("db1", "services.openssh.ports", "[22]", "[23]")])

    def test_prune(self):
        f = {k: v for k, v in FLEET.items() if k != "dev1"}
        core.ingest(self.con, f, prune=True)
        self.assertEqual({r[0] for r in self.con.execute("SELECT name FROM hosts")}, {"web1", "db1"})


class TestApply(Base):
    def test_commit_and_emit(self):
        r = core.apply(self.con, """
            UPDATE opts SET value='false' WHERE path='services.openssh.settings.PasswordAuthentication'
              AND host IN (SELECT host FROM o WHERE path='networking.domain' AND v='prod')""",
                       message="no pw", out_dir=self.out)
        self.assertTrue(r.committed)
        self.assertEqual(r.hosts, ["db1", "web1"])
        self.assertEqual(val(self.con, "db1", "services.openssh.settings.PasswordAuthentication",
                             "overrides"), False)
        text = (Path(self.out) / "web1.nix").read_text()
        self.assertIn("services.openssh.settings.PasswordAuthentication = lib.mkForce false;", text)
        self.assertIn("# changeset 1: no pw", text)
        self.assertNotIn("PasswordAuthentication", (Path(self.out) / "dev1.nix").read_text())
        self.assertTrue((Path(self.out) / "default.nix").exists())

    def test_policy_rolls_back_everything(self):
        with self.assertRaises(PolicyViolation) as cm:
            core.apply(self.con, """
                UPDATE opts SET value='false' WHERE path LIKE '%PasswordAuthentication';
                UPDATE opts SET value='[2222]' WHERE path='services.openssh.ports';""",
                       policies=[SSH_FW_POLICY], out_dir=self.out)
        self.assertEqual(len(cm.exception.violations[0][2]), 3)
        # Neither statement took effect, nothing recorded, nothing written.
        self.assertEqual(val(self.con, "web1", "services.openssh.settings.PasswordAuthentication"), True)
        self.assertEqual(val(self.con, "web1", "services.openssh.ports"), [22])
        self.assertEqual(self.con.execute("SELECT count(*) FROM changesets").fetchone()[0], 0)
        self.assertFalse(Path(self.out).exists())

    def test_consistent_change_passes_policy(self):
        r = core.apply(self.con, """
            UPDATE opts SET value='[2222]' WHERE path='services.openssh.ports';
            UPDATE opts SET value=json_replace(value, '$[0]', 2222)
              WHERE path='networking.firewall.allowedTCPPorts';""", policies=[SSH_FW_POLICY])
        self.assertTrue(r.committed)
        self.assertEqual(val(self.con, "web1", "networking.firewall.allowedTCPPorts"), [2222, 80])

    def test_dry_run(self):
        r = core.apply(self.con, "UPDATE opts SET value='[1]' WHERE path='services.openssh.ports'",
                       dry_run=True)
        self.assertEqual(len(r.changes), 3)
        self.assertFalse(r.committed)
        self.assertEqual(val(self.con, "web1", "services.openssh.ports"), [22])

    def test_value_normalisation(self):
        core.apply(self.con, """
            INSERT INTO opts VALUES('web1', 'services.x.port', 8080);
            INSERT INTO opts VALUES('web1', 'services.x.name', 'plain string');
            INSERT INTO opts VALUES('web1', 'services.x.quoted', '"also"');
            INSERT INTO opts VALUES('web1', 'services.x.list', json_array(1, 'a'));""")
        self.assertEqual(val(self.con, "web1", "services.x.port"), 8080)
        self.assertEqual(val(self.con, "web1", "services.x.name"), "plain string")
        self.assertEqual(val(self.con, "web1", "services.x.quoted"), "also")
        self.assertEqual(val(self.con, "web1", "services.x.list"), [1, "a"])

    def test_noop_update_is_not_a_change(self):
        r = core.apply(self.con, "UPDATE opts SET value=value")
        self.assertEqual(r.changes, [])
        self.assertIsNone(r.changeset)

    def test_authorizer_blocks_other_tables(self):
        for bad in ("DELETE FROM evaluated", "UPDATE overrides SET value='1'",
                    "INSERT INTO changesets(at) VALUES('x')", "DROP TABLE opts",
                    "UPDATE opts SET value='1'; COMMIT", "ATTACH 'x.db' AS x"):
            with self.subTest(bad=bad), self.assertRaises(NixqlError):
                core.apply(self.con, bad)
        self.assertEqual(val(self.con, "web1", "services.openssh.ports"), [22])

    def test_temp_tables_allowed(self):
        r = core.apply(self.con, """
            CREATE TEMP TABLE targets AS SELECT host FROM o WHERE path='networking.domain' AND v='dev';
            UPDATE opts SET value='[2200]' WHERE path='services.openssh.ports'
              AND host IN (SELECT host FROM targets);""")
        self.assertEqual(r.hosts, ["dev1"])

    def test_cannot_delete_nix_defined(self):
        with self.assertRaisesRegex(NixqlError, "cannot be deleted"):
            core.apply(self.con, "DELETE FROM opts WHERE path='services.openssh.ports'")

    def test_delete_override_only_key(self):
        core.apply(self.con, "INSERT INTO opts VALUES('db1','services.y.enable','true')")
        r = core.apply(self.con, "DELETE FROM opts WHERE path='services.y.enable'", out_dir=self.out)
        self.assertEqual(r.changes[0].new, None)
        self.assertIsNone(val(self.con, "db1", "services.y.enable", "overrides"))
        self.assertNotIn("services.y", (Path(self.out) / "db1.nix").read_text())

    def test_rejects_attrset_value_and_unknown_host(self):
        with self.assertRaisesRegex(NixqlError, "leaves"):
            core.apply(self.con, """INSERT INTO opts VALUES('db1','services.z','{"a":1}')""")
        with self.assertRaises(NixqlError):
            core.apply(self.con, "INSERT INTO opts VALUES('nope','a.b','1')")

    def test_sql_null_rejected(self):
        with self.assertRaisesRegex(NixqlError, "NULL"):
            core.apply(self.con, "UPDATE opts SET value=NULL WHERE path='services.openssh.ports'")

    def test_refuses_foreign_out_dir(self):
        Path(self.out).mkdir()
        (Path(self.out) / "mine.txt").write_text("hand written")
        with self.assertRaisesRegex(NixqlError, "not generated by nixql"):
            core.apply(self.con, "UPDATE opts SET value='[1]' WHERE path='services.openssh.ports'",
                       out_dir=self.out)
        self.assertTrue((Path(self.out) / "mine.txt").exists())
        self.assertEqual(val(self.con, "web1", "services.openssh.ports"), [22])

    def test_select_results_returned(self):
        r = core.apply(self.con, "SELECT count(*) FROM opts WHERE path LIKE 'services.openssh.%'")
        self.assertEqual(r.results[0][1], [(6,)])


class TestOverridesLifecycle(Base):
    def test_reingest_keeps_overrides_and_reports_drift(self):
        core.apply(self.con, "UPDATE opts SET value='[2222]' WHERE path='services.openssh.ports' AND host='db1'")
        # Not deployed: Nix still evaluates to [22] -> drift, but desired state keeps 2222.
        rep = core.ingest(self.con, json.loads(json.dumps(FLEET)))
        self.assertEqual(rep.drift, [("db1", "services.openssh.ports", "[2222]", "[22]")])
        self.assertEqual(val(self.con, "db1", "services.openssh.ports"), [2222])
        # Deployed (override imported): evaluation reflects it -> no drift, override kept.
        f = json.loads(json.dumps(FLEET))
        f["db1"]["services"]["openssh"]["ports"] = [2222]
        rep = core.ingest(self.con, f)
        self.assertEqual(rep.drift, [])
        self.assertEqual(val(self.con, "db1", "services.openssh.ports", "overrides"), [2222])

    def test_revert(self):
        core.apply(self.con, "UPDATE opts SET value='[2222]' WHERE path='services.openssh.ports'")
        r = core.revert(self.con, 1, out_dir=self.out)
        self.assertTrue(r.committed)
        self.assertEqual(val(self.con, "web1", "services.openssh.ports"), [22])
        self.assertEqual(self.con.execute("SELECT count(*) FROM overrides").fetchone()[0], 0)
        self.assertEqual(self.con.execute("SELECT reverts FROM changesets WHERE id=2").fetchone()[0], 1)

    def test_revert_restores_previous_override(self):
        core.apply(self.con, "UPDATE opts SET value='[2000]' WHERE path='services.openssh.ports' AND host='db1'")
        core.apply(self.con, "UPDATE opts SET value='[3000]' WHERE path='services.openssh.ports' AND host='db1'")
        core.revert(self.con, 2)
        self.assertEqual(val(self.con, "db1", "services.openssh.ports"), [2000])
        self.assertEqual(val(self.con, "db1", "services.openssh.ports", "overrides"), [2000])

    def test_revert_conflict(self):
        core.apply(self.con, "UPDATE opts SET value='[2000]' WHERE path='services.openssh.ports' AND host='db1'")
        core.apply(self.con, "UPDATE opts SET value='[3000]' WHERE path='services.openssh.ports' AND host='db1'")
        with self.assertRaisesRegex(NixqlError, "conflict"):
            core.revert(self.con, 1)
        self.assertEqual(val(self.con, "db1", "services.openssh.ports"), [3000])
        core.revert(self.con, 1, force=True)
        self.assertEqual(val(self.con, "db1", "services.openssh.ports"), [22])

    def test_revert_checked_by_policies(self):
        # cs1 opens 2222 in the firewall; cs2 moves sshd to 2222.
        core.apply(self.con, "UPDATE opts SET value='[22, 2222]' WHERE path='networking.firewall.allowedTCPPorts'",
                   policies=[SSH_FW_POLICY])
        core.apply(self.con, "UPDATE opts SET value='[2222]' WHERE path='services.openssh.ports'",
                   policies=[SSH_FW_POLICY])
        # Reverting cs1 alone would lock everyone out -> refused, nothing changes.
        with self.assertRaises(PolicyViolation):
            core.revert(self.con, 1, policies=[SSH_FW_POLICY])
        self.assertEqual(val(self.con, "db1", "networking.firewall.allowedTCPPorts"), [22, 2222])
        self.assertEqual(self.con.execute("SELECT count(*) FROM changesets").fetchone()[0], 2)


class TestOptionTypes(Base):
    U16 = {"name": "unsignedInt16", "description": "16 bit unsigned integer; between 0 and 65535 (both inclusive)"}

    def test_type_check(self):
        tc = core.type_check
        self.assertTrue(tc({"name": "bool"}, False))
        self.assertFalse(tc({"name": "bool"}, "yes"))
        self.assertFalse(tc({"name": "int"}, True))  # bools are not ints
        self.assertTrue(tc(self.U16, 22))
        self.assertFalse(tc(self.U16, 70000))
        self.assertFalse(tc({"name": "listOf", "elemType": self.U16}, [22, -1]))
        enum = {"name": "enum", "values": ["yes", "no"]}
        self.assertTrue(tc({"name": "nullOr", "elemType": enum}, None))
        self.assertFalse(tc({"name": "nullOr", "elemType": enum}, "maybe"))
        self.assertTrue(tc({"name": "either", "left": {"name": "bool"}, "right": {"name": "str"}}, "x"))
        self.assertIsNone(tc({"name": "submodule"}, 1))  # can't tell -> no opinion
        self.assertIsNone(tc({"name": "listOf", "elemType": {"name": "package"}}, ["x"]))

    def test_opt_match(self):
        m = core.opt_match
        self.assertGreater(m('users.users."<name>".uid', "users.users.ops.uid"), 0)
        self.assertEqual(m('users.users."<name>".uid', "users.users.ops.shell"), 0)
        self.assertGreater(m("users.users.root.uid", "users.users.root.uid"),
                           m('users.users."<name>".uid', "users.users.root.uid"))
        self.assertGreater(m("services.openssh", "services.openssh.ports"), 0)

    def test_apply_rejects_badly_typed_values(self):
        self.con.executemany("INSERT INTO options VALUES(?,?,?,?,?)", [
            (h, "services.openssh.ports", json.dumps({"name": "listOf", "elemType": self.U16}), "", "[]")
            for h in ("web1", "db1", "dev1")])
        with self.assertRaisesRegex(NixqlError, "type error"):
            core.apply(self.con, "UPDATE opts SET value='[70000]' WHERE path='services.openssh.ports'")
        self.assertEqual(val(self.con, "web1", "services.openssh.ports"), [22])
        self.assertTrue(core.apply(self.con, "UPDATE opts SET value='[2222]' WHERE path='services.openssh.ports'").committed)

    def test_why_view(self):
        self.con.execute("INSERT INTO options VALUES('web1', 'users.users.\"<name>\".isNormalUser', "
                         "'{\"name\":\"bool\"}', 'boolean', '[\"/etc/nixos/users.nix\"]')")
        r = self.con.execute("SELECT option, files FROM why WHERE host='web1' AND path LIKE 'users.%'").fetchone()
        self.assertEqual(r, ('users.users."<name>".isNormalUser', '["/etc/nixos/users.nix"]'))


NIXPKGS = __import__("os").environ.get("NIXPKGS")


@unittest.skipUnless(HAVE_NIX and NIXPKGS, "needs nix and $NIXPKGS (a nixpkgs checkout)")
class TestRealNixOS(unittest.TestCase):
    def test_ingest_with_options_and_typecheck(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            src = ROOT / "examples" / "nixos" / "fleet.nix"
            shutil.copy(src, tmp / "fleet.nix")
            fleet, options = core.eval_fleet_full(
                str(tmp / "fleet.nix"), select=["services.openssh", "networking.firewall", "users.users"],
                with_options=True)
            con = core.connect(tmp / "f.db")
            core.ingest(con, fleet, options=options)
            self.assertEqual(val(con, "web1", "networking.firewall.allowedTCPPorts"), [22, 80, 443])
            with self.assertRaisesRegex(NixqlError, "boolean"):
                core.apply(con, "UPDATE opts SET value='\"yes\"' WHERE path='services.openssh.settings.PasswordAuthentication'")
            with self.assertRaisesRegex(NixqlError, "integer"):
                core.apply(con, "UPDATE opts SET value='\"x\"' WHERE path='users.users.ops.uid'")
            r = core.apply(con, "UPDATE opts SET value='[2222]' WHERE path='services.openssh.ports'",
                           out_dir=str(tmp / "nixql-overrides"))
            self.assertTrue(r.committed)
            # Re-evaluate with the generated overrides imported: no drift.
            fleet, options = core.eval_fleet_full(str(tmp / "fleet.nix"),
                                                  select=["services.openssh", "networking.firewall", "users.users"])
            self.assertEqual(core.ingest(con, fleet).drift, [])
            self.assertEqual(val(con, "db1", "services.openssh.ports", "evaluated"), [2222])
        finally:
            shutil.rmtree(tmp)


@unittest.skipUnless(HAVE_NIX, "nix not installed")
class TestNix(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_eval_fleet_with_serializer_and_select(self):
        f = self.tmp / "fleet.nix"
        f.write_text("""{
          a = { services.x = { enable = true; pkg = { type = "derivation"; name = "hello-1"; };
                               hook = x: x; bad = throw "nope"; }; other.y = 1; };
          b = { config = { services.x.enable = false; }; options = { }; };
        }""")
        fleet = core.eval_fleet(str(f), select=["services.x"])
        self.assertEqual(fleet["a"]["services"]["x"]["pkg"], {"__nixql": "derivation", "name": "hello-1"})
        self.assertEqual(fleet["a"]["services"]["x"]["hook"], {"__nixql": "function"})
        self.assertEqual(fleet["a"]["services"]["x"]["bad"], {"__nixql": "error"})
        self.assertNotIn("other", fleet["a"])
        self.assertEqual(fleet["b"], {"services": {"x": {"enable": False}}})  # used .config
        self.assertEqual(set(core.eval_fleet(str(f), hosts=["b"])), {"b"})

    def test_emitted_module_evaluates(self):
        con = core.connect(self.tmp / "f.db")
        core.ingest(con, json.loads(json.dumps(FLEET)))
        core.apply(con, """
            UPDATE opts SET value='[2222]' WHERE path='services.openssh.ports';
            INSERT INTO opts VALUES('web1', 'users.users."bob.smith".extraGroups', '["wheel"]');
            INSERT INTO opts VALUES('web1', 'services.x.n', -5);""", out_dir=str(self.tmp / "ov"))
        # Evaluate the module with a stub lib whose mkForce is the identity.
        expr = f"import (import {self.tmp / 'ov'}).web1 {{ lib.mkForce = x: x; }}"
        out = subprocess.run(["nix", "eval", "--impure", "--json", "--expr", expr],
                             capture_output=True, text=True, check=True).stdout
        self.assertEqual(json.loads(out), {
            "services": {"openssh": {"ports": [2222]}, "x": {"n": -5}},
            "users": {"users": {"bob.smith": {"extraGroups": ["wheel"]}}}})


class TestCli(unittest.TestCase):
    def test_end_to_end(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            (tmp / "fleet.json").write_text(json.dumps(FLEET))
            (tmp / "policies").mkdir()
            (tmp / "policies" / "ssh_fw.sql").write_text(SSH_FW_POLICY[1])

            def run(*a):
                return subprocess.run([str(ROOT / "bin" / "nixql"), *a], cwd=tmp,
                                      capture_output=True, text=True)
            self.assertEqual(run("ingest", "fleet.json").returncode, 0)
            bad = run("apply", "UPDATE opts SET value='[2222]' WHERE path='services.openssh.ports'")
            self.assertEqual(bad.returncode, 3, bad.stderr)
            self.assertIn("ssh_fw", bad.stderr)
            ok = run("apply", "-m", "move", "--hosts-only",
                     "UPDATE opts SET value='[2222]' WHERE path LIKE '%openssh.ports' AND host='db1';"
                     "UPDATE opts SET value='[2222]' WHERE path LIKE '%allowedTCPPorts' AND host='db1'")
            self.assertEqual(ok.returncode, 0, ok.stderr)
            self.assertEqual(ok.stdout.strip(), "db1")
            q = run("q", "--format", "json", "SELECT host, v FROM o WHERE path='services.openssh.ports' AND host='db1'")
            self.assertEqual(json.loads(q.stdout), [{"host": "db1", "v": "[2222]"}])
            self.assertIn("#1", run("log").stdout)
            self.assertIn("not yet reflected", run("status").stdout)
            self.assertEqual(run("q", "DELETE FROM opts").returncode, 2)  # read-only
            self.assertEqual(run("revert", "1").returncode, 0)
        finally:
            shutil.rmtree(tmp)


if __name__ == "__main__":
    unittest.main()
