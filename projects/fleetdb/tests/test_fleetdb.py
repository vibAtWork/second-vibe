import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import fleetdb  # noqa: E402
from fleetdb import FleetError, Violations  # noqa: E402

SEED = (ROOT / "examples" / "seed.sql").read_text()
HAVE_NIX = shutil.which("nix") is not None


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.out = str(self.tmp / "fleet.json")
        self.con = fleetdb.connect(self.tmp / "f.sqlite")
        fleetdb.transact(self.con, SEED, "seed", self.out)

    def tearDown(self):
        self.con.close()
        shutil.rmtree(self.tmp)

    def doc(self):
        return json.loads(Path(self.out).read_text())

    def one(self, sql, *a):
        return self.con.execute(sql, a).fetchone()[0]


class TestExport(Base):
    def test_seed_export(self):
        d = self.doc()
        self.assertEqual(sorted(d["hosts"]), ["db1", "web1", "web2"])
        db1 = d["hosts"]["db1"]
        self.assertEqual(sorted(db1["users"]), ["alice", "carol"])
        self.assertTrue(db1["users"]["carol"]["wheel"])
        self.assertEqual(db1["tcpPorts"], [22])  # postgres not public
        self.assertEqual(d["hosts"]["web1"]["tcpPorts"], [22, 443])
        self.assertNotIn("db1", db1["knownHosts"])  # not itself
        self.assertEqual(db1["etcHosts"]["10.0.0.11"], ["web1.example.net", "web1"])

    def test_deterministic(self):
        a = fleetdb.export_doc(self.con)
        b = fleetdb.export_doc(self.con)
        self.assertEqual(a, b)
        self.assertEqual(a["sha256"], self.doc()["sha256"])


class TestTransactions(Base):
    def test_add_host_changes_every_host(self):
        txn, diff, _ = fleetdb.transact(self.con, """
            INSERT INTO hosts(name, ip, host_key) VALUES ('web3', '10.0.0.13', 'ssh-ed25519 AAAA web3');
            INSERT INTO access VALUES ('alice', 'web3', 1);""", "add", self.out)
        self.assertIsNotNone(txn)
        self.assertEqual({h for h, *_ in diff}, {"db1", "web1", "web2", "web3"})
        self.assertIn("web3", self.doc()["hosts"]["db1"]["knownHosts"])

    def test_violation_rolls_back_db_and_file(self):
        before = Path(self.out).read_text()
        with self.assertRaises(Violations) as cm:
            fleetdb.transact(self.con, "UPDATE access SET wheel=0 WHERE user='alice'", "x", self.out)
        self.assertEqual({s for _, s in cm.exception.rows}, {"web1", "web2"})
        self.assertEqual(self.one("SELECT count(*) FROM access WHERE wheel=1 AND user='alice'"), 3)
        self.assertEqual(Path(self.out).read_text(), before)
        self.assertEqual(self.one("SELECT count(*) FROM txns"), 1)  # seed only

    def test_constraints(self):
        for bad in ("INSERT INTO users VALUES ('dave', 1001, 'bash', 1)",        # dup uid
                    "INSERT INTO users VALUES ('dave', 30001, 'bash', 1)",       # nixbld range
                    "INSERT INTO hosts(name, ip) VALUES ('Web9', '10.0.0.99')",  # bad name
                    "INSERT INTO hosts(name, ip) VALUES ('web9', '10.0.0.11')",  # dup ip
                    "INSERT INTO services VALUES ('web1', 'other', 443, 0)",     # port clash
                    "INSERT INTO access VALUES ('nobody', 'web1', 0)"):         # FK
            with self.subTest(bad=bad), self.assertRaises(FleetError):
                fleetdb.transact(self.con, bad, "x", self.out)

    def test_deferred_fk_allows_reordering_within_txn(self):
        # Child row first, parent second: fine because FKs are checked at commit.
        txn, _, _ = fleetdb.transact(self.con, """
            INSERT INTO access VALUES ('erin', 'web1', 0);
            INSERT INTO users VALUES ('erin', 1010, 'bash', 1);""", "x", self.out)
        self.assertIsNotNone(txn)

    def test_view_rules(self):
        with self.assertRaises(Violations):
            fleetdb.transact(self.con, "UPDATE services SET public=1 WHERE name='postgresql'", "x", self.out)
        with self.assertRaises(Violations):
            fleetdb.transact(self.con, "UPDATE services SET port=22 WHERE host='web1' AND name='nginx'", "x", self.out)
        with self.assertRaises(Violations):
            fleetdb.transact(self.con, "DELETE FROM ssh_keys WHERE user='carol'", "x", self.out)

    def test_authorizer(self):
        for bad in ("DELETE FROM audit", "UPDATE txns SET message='x'", "DROP TABLE hosts",
                    "UPDATE hosts SET env='dev'; COMMIT", "ATTACH 'x' AS y"):
            with self.subTest(bad=bad), self.assertRaises(FleetError):
                fleetdb.transact(self.con, bad, "x", self.out)
        self.assertEqual(self.one("SELECT count(*) FROM hosts WHERE env='dev'"), 0)

    def test_plan_and_noop(self):
        txn, diff, _ = fleetdb.transact(self.con, "UPDATE hosts SET ssh_port=2222", "x", self.out, dry_run=True)
        self.assertIsNone(txn)
        self.assertEqual(len([d for d in diff if d[2] == "sshPort"]), 3)
        self.assertEqual(self.one("SELECT max(ssh_port) FROM hosts"), 22)
        txn, diff, _ = fleetdb.transact(self.con, "SELECT 1", "x", self.out)
        self.assertIsNone(txn)
        self.assertEqual(diff, [])


class TestUndo(Base):
    def roundtrip(self, sql):
        before = fleetdb.export_doc(self.con)["sha256"]
        txn, _, _ = fleetdb.transact(self.con, sql, "change", self.out)
        self.assertNotEqual(fleetdb.export_doc(self.con)["sha256"], before)
        fleetdb.undo(self.con, txn, self.out)
        self.assertEqual(fleetdb.export_doc(self.con)["sha256"], before)
        self.assertEqual(self.doc()["sha256"], before)

    def test_undo_insert(self):
        self.roundtrip("INSERT INTO hosts(name, ip) VALUES ('web3', '10.0.0.13');"
                       "INSERT INTO access VALUES ('alice', 'web3', 1)")

    def test_undo_update(self):
        self.roundtrip("UPDATE hosts SET ssh_port = 2222")

    def test_undo_cascading_delete(self):
        self.roundtrip("DELETE FROM users WHERE name='bob'")  # cascades access + keys

    def test_undo_cascading_rename(self):
        self.roundtrip("UPDATE users SET name='robert' WHERE name='bob'")

    def test_undo_is_checked(self):
        txn, _, _ = fleetdb.transact(self.con, "INSERT INTO users VALUES ('dan', 1020, 'bash', 1);"
                                     "INSERT INTO ssh_keys VALUES ('dan', 'ssh-ed25519 AAAA dan', NULL);"
                                     "INSERT INTO access VALUES ('dan', 'web1', 1)", "dan", self.out)
        fleetdb.transact(self.con, "DELETE FROM access WHERE user='alice' AND host='web1'", "x", self.out)
        with self.assertRaises(Violations):  # undoing dan would leave web1 without wheel
            fleetdb.undo(self.con, txn, self.out)


@unittest.skipUnless(HAVE_NIX, "nix not installed")
class TestNix(Base):
    def test_to_nixos(self):
        expr = (f"builtins.mapAttrs (_: import {ROOT / 'to-nixos.nix'} {{}}) "
                f"(builtins.fromJSON (builtins.readFile {self.out})).hosts")
        out = json.loads(subprocess.run(["nix", "eval", "--impure", "--json", "--expr", expr],
                                        capture_output=True, text=True, check=True).stdout)
        db1 = out["db1"]
        self.assertEqual(db1["users"]["users"]["carol"],
                         {"isNormalUser": True, "uid": 1002, "shell": "fish", "extraGroups": ["wheel"],
                          "openssh": {"authorizedKeys": {"keys": ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICarol carol@x"]}}})
        self.assertTrue(db1["programs"]["fish"]["enable"])
        self.assertFalse(out["web1"]["programs"]["fish"]["enable"])
        self.assertEqual(out["web1"]["networking"]["firewall"]["allowedTCPPorts"], [22, 443])


class TestCli(Base):
    def run_cli(self, *a):
        return subprocess.run([sys.executable, str(ROOT / "fleetdb.py"), "--db", str(self.tmp / "f.sqlite"),
                               "--out", self.out, *a], capture_output=True, text=True)

    def test_cli(self):
        self.assertEqual(self.run_cli("status").returncode, 0)
        r = self.run_cli("sql", "-m", "port", "UPDATE hosts SET ssh_port=2222 WHERE name='db1'")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.doc()["hosts"]["db1"]["sshPort"], 2222)
        r = self.run_cli("sql", "UPDATE access SET wheel=0")
        self.assertEqual(r.returncode, 3)
        self.assertIn("lockout", r.stderr)
        self.assertEqual(self.run_cli("q", "DELETE FROM hosts").returncode, 2)  # read-only
        Path(self.out).write_text('{"hosts": {}}')
        self.assertEqual(self.run_cli("status").returncode, 1)
        self.assertIn("port", self.run_cli("log").stdout)


if __name__ == "__main__":
    unittest.main()
