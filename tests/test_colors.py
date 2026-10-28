import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import db  # noqa: E402
import geometry  # noqa: E402
from app import create_app  # noqa: E402

BLUE = "#1e3a8a"


class ColorApiTest(unittest.TestCase):
    def setUp(self):
        fd, self.db_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.uploads = tempfile.mkdtemp()
        self.client = create_app(self.db_path, self.uploads).test_client()
        conn = db.connect(self.db_path)
        # Two blue holds, a red one, one with no color, and a removed blue one.
        for col, name, color, removed in [(0, "Anchor", BLUE, None), (1, "Badger", BLUE, None), (2, "Cobra", "#7a0404", None),
                                          (3, "Dingo", None, None), (4, "Eagle", BLUE, "2026-10-01")]:
            x, y = geometry.tnut_xy(col, 0)
            conn.execute("INSERT INTO holds (name, x, y, tnut_col, tnut_row, color, removed_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
                         (name, x, y, col, color, removed))
        conn.commit()
        conn.close()

    def tearDown(self):
        os.remove(self.db_path)

    def colors(self):
        return self.client.get("/api/colors").get_json()

    def color(self, name):
        return next(c for c in self.colors() if c["name"] == name)

    def hold_colors(self):
        conn = db.connect(self.db_path)
        try:
            return {r["name"]: r["color"] for r in conn.execute("SELECT name, color FROM holds")}
        finally:
            conn.close()

    def test_defaults_in_order_with_counts(self):
        colors = self.colors()
        self.assertEqual([(c["name"], c["hex"]) for c in colors], db.DEFAULT_COLORS)
        self.assertEqual(self.color("Blue")["holds"], 2)        # the removed one doesn't count
        self.assertEqual(self.color("Red")["holds"], 1)
        self.assertEqual(self.color("Lime")["holds"], 0)

    def test_create(self):
        res = self.client.post("/api/colors", json={"name": "  Mint ", "hex": "#3EB489"})
        self.assertEqual(res.status_code, 201, res.get_json())
        self.assertEqual({k: res.get_json()[k] for k in ("name", "hex", "holds")}, {"name": "Mint", "hex": "#3eb489", "holds": 0})
        self.assertEqual(self.colors()[-1]["name"], "Mint")

        def post(data):
            res = self.client.post("/api/colors", json=data)
            return res.status_code, res.get_json().get("error", "")

        self.assertEqual(post({"name": "Sea", "hex": "3eb48"})[0], 400)
        self.assertEqual(post({"name": "Sea", "hex": "#3eb48g"})[0], 400)
        self.assertEqual(post({"name": "Sea"})[0], 400)
        self.assertEqual(post({"name": "  ", "hex": "#123456"})[0], 400)
        self.assertEqual(post({"name": "x" * 25, "hex": "#123456"})[0], 400)
        self.assertEqual(post({"name": "blue", "hex": "#123456"}), (400, "There's already a color called Blue"))
        self.assertEqual(post({"name": "Sea", "hex": "#3EB489"}), (400, "Mint is already #3EB489"))

    def test_rename_only(self):
        blue = self.color("Blue")
        res = self.client.put("/api/colors/%d" % blue["id"], json={"name": "Cobalt"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual((res.get_json()["color"]["name"], res.get_json()["color"]["hex"], res.get_json()["recolored"]), ("Cobalt", BLUE, 0))
        self.assertEqual(self.hold_colors()["Anchor"], BLUE)

    def test_new_hex_recolors_its_holds(self):
        blue = self.color("Blue")
        res = self.client.put("/api/colors/%d" % blue["id"], json={"hex": "#1E3C8C"})
        self.assertEqual(res.status_code, 200, res.get_json())
        self.assertEqual(res.get_json()["recolored"], 2)
        self.assertEqual(res.get_json()["color"]["hex"], "#1e3c8c")
        self.assertEqual(self.hold_colors(), {"Anchor": "#1e3c8c", "Badger": "#1e3c8c", "Cobra": "#7a0404", "Dingo": None, "Eagle": "#1e3c8c"})
        self.assertEqual(self.color("Blue")["holds"], 2)

    def test_update_validation(self):
        blue = self.color("Blue")
        url = "/api/colors/%d" % blue["id"]
        self.assertEqual(self.client.put(url, json={"name": "Red"}).status_code, 400)
        self.assertEqual(self.client.put(url, json={"hex": "#7A0404"}).status_code, 400)
        self.assertEqual(self.client.put(url, json={"hex": "nope"}).status_code, 400)
        self.assertEqual(self.client.put(url, json={"name": "BLUE"}).status_code, 200)        # its own name, new case
        self.assertEqual(self.client.put("/api/colors/999", json={"name": "X"}).status_code, 404)
        self.assertEqual(self.hold_colors()["Anchor"], BLUE)

    def test_delete_only_when_unused(self):
        red, lime = self.color("Red"), self.color("Lime")
        res = self.client.delete("/api/colors/%d" % red["id"])
        self.assertEqual((res.status_code, res.get_json()["error"]), (400, "Red is used by 1 hold. Recolor it first"))
        self.assertEqual(self.client.delete("/api/colors/%d" % lime["id"]).status_code, 200)
        self.assertNotIn("Lime", [c["name"] for c in self.colors()])
        self.assertEqual(self.client.delete("/api/colors/%d" % lime["id"]).status_code, 404)

    def test_an_edited_list_is_not_refilled(self):
        for c in self.colors():
            if not c["holds"]:
                self.client.delete("/api/colors/%d" % c["id"])
        left = [c["name"] for c in self.colors()]
        self.assertEqual(left, ["Red", "Blue"])
        fresh = create_app(self.db_path, self.uploads).test_client()     # a restart
        self.assertEqual([c["name"] for c in fresh.get("/api/colors").get_json()], left)

    def test_bulk_recolor(self):
        holds = {h["name"]: h["id"] for h in self.client.get("/api/holds").get_json()}
        res = self.client.put("/api/holds/color", json={"hold_ids": [holds["Anchor"], holds["Dingo"], holds["Dingo"]], "color": "#1E8A3C"})
        self.assertEqual(res.status_code, 200, res.get_json())
        self.assertEqual([(h["name"], h["color"]) for h in res.get_json()], [("Anchor", "#1e8a3c"), ("Dingo", "#1e8a3c")])
        self.assertEqual(self.hold_colors()["Badger"], BLUE)
        res = self.client.put("/api/holds/color", json={"hold_ids": [holds["Anchor"]], "color": None})
        self.assertEqual(res.get_json()[0]["color"], None)

        def put(data):
            return self.client.put("/api/holds/color", json=data).status_code

        self.assertEqual(put({"hold_ids": [holds["Anchor"]], "color": "green"}), 400)
        self.assertEqual(put({"hold_ids": [holds["Anchor"]]}), 400)
        self.assertEqual(put({"hold_ids": [], "color": BLUE}), 400)
        self.assertEqual(put({"hold_ids": [999], "color": BLUE}), 400)
        self.assertEqual(put({"hold_ids": [holds["Eagle"]], "color": BLUE}), 400)       # removed
        self.assertEqual(put({"hold_ids": [True], "color": BLUE}), 400)
        self.assertEqual(put({"hold_ids": list(range(1, 502)), "color": BLUE}), 400)
        self.assertEqual(put({"hold_ids": "1", "color": BLUE}), 400)


class ColorMigrationTest(unittest.TestCase):
    def test_old_database_gains_the_default_list(self):
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        try:
            conn = db.connect(path)
            conn.execute("CREATE TABLE holds (id INTEGER PRIMARY KEY, x REAL NOT NULL, y REAL NOT NULL, tnut_col INTEGER, tnut_row INTEGER)")
            conn.commit()
            conn.close()
            client = create_app(path, tempfile.mkdtemp()).test_client()
            self.assertEqual(len(client.get("/api/colors").get_json()), len(db.DEFAULT_COLORS))
        finally:
            os.remove(path)


if __name__ == "__main__":
    unittest.main()
