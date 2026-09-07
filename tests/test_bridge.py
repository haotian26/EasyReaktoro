import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PYTHON = Path(os.environ.get("EASYREAKTORO_PYTHON", "/Applications/Reaktoro/envs/reaktoro/bin/python"))


@unittest.skipUnless(PYTHON.exists(), "external Reaktoro Python is not installed")
class BridgeIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.proc = subprocess.Popen(
            [str(PYTHON), "-B", str(ROOT / "bridge/reaktoro_bridge.py")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
        )

    def tearDown(self):
        self.proc.stdin.close()
        self.proc.stdout.close()
        self.proc.terminate()
        self.proc.wait(timeout=5)

    def request(self, payload):
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()
        return json.loads(self.proc.stdout.readline())

    def test_live_catalog_and_species(self):
        probe = self.request({"op": "runtime.probe"})
        self.assertEqual(probe["status"], "ready")
        self.assertEqual(probe["version"], "2.13.0")
        catalog = self.request({"op": "catalog.list"})["entries"]
        self.assertEqual(len(catalog), 19)
        self.assertTrue(all(entry["status"] == "ready" for entry in catalog))
        self.assertNotIn("supcrt92", {entry["embedded_name"] for entry in catalog})
        for group, name, count in (("PHREEQC", "phreeqc.dat", 381), ("PHREEQC", "llnl.dat", 2612), ("SUPCRT", "supcrtbl", 1108), ("NASA", "nasa-cea", 1658)):
            summary = self.request({"op": "database.open", "group": group, "name": name})["summary"]
            self.assertEqual(summary["species_count"], count)
            page = self.request({"op": "database.species_page", "handle_id": summary["handle_id"], "offset": 0, "limit": 3, "state": "All", "query": ""})
            self.assertEqual(page["total"], count)
            self.assertIsInstance(page["items"][0], dict)
            evaluation = self.request({"op": "species.evaluate", "handle_id": summary["handle_id"], "name": page["items"][0]["name"], "temperature_K": 298.15, "pressure_Pa": 100000})
            self.assertIn("properties", evaluation)

        summary = self.request({"op": "database.open", "group": "PHREEQC", "name": "phreeqc.dat"})["summary"]
        filtered = self.request({"op": "database.species_page", "handle_id": summary["handle_id"], "offset": 0, "limit": 100, "state": "All", "query": "", "elements": ["Na", "Cl"], "model": "All"})
        self.assertGreater(filtered["total"], 0)
        self.assertTrue(all({"Na", "Cl"}.issubset(set(item["elements"])) for item in filtered["items"]))
        searched = self.request({"op": "database.species_page", "handle_id": summary["handle_id"], "offset": 0, "limit": 100, "state": "All", "query": "calcite", "elements": [], "model": "All"})
        self.assertTrue(any("calcite" in item["name"].lower() for item in searched["items"]))

    def test_rtdb_atomic_create_open(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "test.rtdb")
            created = self.request({"op": "rtdb.create", "path": path, "name": "Test"})["summary"]
            self.assertEqual(created["species_count"], 0)
            reopened = self.request({"op": "rtdb.open", "path": path})["summary"]
            self.assertEqual(reopened["kind"], "rtdb")
            self.assertEqual(reopened["embedded_name"], "test")
            self.assertTrue(Path(path).exists())

    def test_copied_native_species_uses_live_source_for_thermo(self):
        official = self.request({"op": "database.open", "group": "PHREEQC", "name": "phreeqc.dat"})["summary"]
        details = self.request({
            "op": "species.details", "handle_id": official["handle_id"], "name": "Calcite",
        })
        self.assertTrue(details["ok"])
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "copied-native.rtdb")
            local = self.request({
                "op": "rtdb.create", "path": path, "name": "组合数据库", "records": [details],
            })["summary"]
            self.assertEqual(local["embedded_name"], "copied-native")
            result = self.request({
                "op": "species.evaluate", "handle_id": local["handle_id"], "name": "Calcite",
                "temperature_K": 298.15, "pressure_Pa": 100000,
            })
            self.assertTrue(result["ok"])
            self.assertIsInstance(result["properties"]["G0"], float)
            self.assertNotEqual(result["properties"]["G0"], 0.0)


if __name__ == "__main__":
    unittest.main()
