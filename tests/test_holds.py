import io
import os
import shutil
import sqlite3
import struct
import sys
import tempfile
import unittest
import zlib

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import db  # noqa: E402
import geometry  # noqa: E402
import hold_names  # noqa: E402
from app import create_app  # noqa: E402


def png_bytes(w=4, h=4):
    """A tiny RGBA PNG with a checkerboard of opaque and transparent pixels."""
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    rows = b"".join(
        b"\x00" + b"".join(struct.pack("BBBB", 200, 60, 60, 255 if (x + y) % 2 else 0) for x in range(w))
        for y in range(h)
    )
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


class NamingTest(unittest.TestCase):
    def test_name_letter_uses_last_letter_of_column(self):
        self.assertEqual(geometry.name_letter(5), "F")
        self.assertEqual(geometry.name_letter(26), "A")   # AA
        self.assertEqual(geometry.name_letter(27), "B")   # AB
        self.assertEqual(geometry.name_letter(39), "N")   # AN

    def test_nearest_tnut(self):
        x, y = geometry.tnut_xy(5, 11)
        self.assertEqual(geometry.nearest_tnut(x + 1.2, y - 1.4)[:2], (5, 11))
        self.assertAlmostEqual(geometry.nearest_tnut(x + 1.2, y - 1.4)[2], (1.2 ** 2 + 1.4 ** 2) ** 0.5)
        # Points in the margins clamp to the edge holes.
        self.assertEqual(geometry.nearest_tnut(0, 0)[:2], (39, 0))
        self.assertEqual(geometry.nearest_tnut(geometry.WIDTH, geometry.HEIGHT)[:2], (0, 38))

    def test_footboard_geometry(self):
        self.assertEqual(geometry.FOOT_COLS, 15)
        self.assertEqual(geometry.TOTAL_HEIGHT, 127.75)
        spec = geometry.board_spec()["foot"]
        self.assertEqual((spec["col_labels"][0], spec["col_labels"][-1]), ("A\u2032", "O\u2032"))
        self.assertEqual(spec["row_labels"], ["40", "41"])
        # First column 4" from the right; rows 2.5" from the footboard's top and bottom.
        self.assertEqual(geometry.tnut_xy(0, 39), (116.0, geometry.FOOT_TOP + 2.5))
        self.assertEqual(geometry.tnut_xy(14, 40), (4.0, geometry.TOTAL_HEIGHT - 2.5))
        self.assertEqual(geometry.tnut_xy(1, 39)[0] - geometry.tnut_xy(2, 39)[0], 8.0)
        self.assertEqual(geometry.tnut_label(2, 39), "C\u203240")
        self.assertEqual(geometry.tnut_label(5, 11), "F12")
        self.assertEqual(geometry.name_letter(2), "C")

    def test_nearest_tnut_across_the_gap(self):
        top_of_gap = geometry.HEIGHT + 0.2
        bottom_of_gap = geometry.FOOT_TOP - 0.2
        self.assertEqual(geometry.nearest_tnut(100, top_of_gap)[1], 38)     # main row 39
        self.assertEqual(geometry.nearest_tnut(100, bottom_of_gap)[1], 39)  # footboard row 40
        x, y = geometry.tnut_xy(3, 40)  # D′41
        col, row, dist = geometry.nearest_tnut(x + 3.1, y - 1.2)
        self.assertEqual((col, row), (3, 40))
        self.assertAlmostEqual(dist, (3.1 ** 2 + 1.2 ** 2) ** 0.5)
        self.assertFalse(geometry.on_panel(50, geometry.HEIGHT + 0.5))
        self.assertTrue(geometry.on_panel(50, geometry.FOOT_TOP + 4))

    def test_every_letter_has_nouns(self):
        self.assertEqual(sorted(hold_names.NOUNS), [chr(c) for c in range(ord("A"), ord("Z") + 1)])
        for letter, nouns in hold_names.NOUNS.items():
            self.assertTrue(all(n.startswith(letter) for n in nouns), letter)
            self.assertEqual(len(nouns), len(set(nouns)), letter)

    def test_suggest_name_avoids_taken(self):
        taken = set(hold_names.NOUNS["X"][:-1])
        self.assertEqual(hold_names.suggest_name(taken, "X"), hold_names.NOUNS["X"][-1])
        taken = set(hold_names.NOUNS["X"])
        self.assertEqual(hold_names.suggest_name(taken, "X"), hold_names.NOUNS["X"][0] + " 2")


class HoldApiTest(unittest.TestCase):
    def setUp(self):
        fd, self.db_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.upload_dir = tempfile.mkdtemp()
        self.app = create_app(self.db_path, self.upload_dir)
        self.client = self.app.test_client()
        conn = db.connect(self.db_path)
        # Proxy holds at A1, F12, K20 and P30.
        for col, row, name in [(0, 0, "Anchor"), (5, 11, "Falcon"), (10, 19, "Kite"), (15, 29, "Pebble")]:
            x, y = geometry.tnut_xy(col, row)
            conn.execute("INSERT INTO holds (name, x, y, tnut_col, tnut_row) VALUES (?, ?, ?, ?, ?)",
                         (name, x, y, col, row))
        conn.commit()
        conn.close()
        self.alex = self.client.post("/api/climbers", json={"name": "Alex"}).get_json()["id"]

    def tearDown(self):
        os.remove(self.db_path)
        shutil.rmtree(self.upload_dir)

    def upload(self, status=201, image=None, **fields):
        data = {k: str(v) for k, v in fields.items()}
        data["image"] = (io.BytesIO(png_bytes() if image is None else image), "hold.png")
        res = self.client.post("/api/holds", data=data, content_type="multipart/form-data")
        self.assertEqual(res.status_code, status, res.get_json())
        return res.get_json()

    def holds(self):
        return {h["id"]: h for h in self.client.get("/api/holds").get_json()}

    def route(self, name, holds, parent=None):
        data = {"name": name, "grade": "easy", "set_date": "2026-09-01", "setter_id": self.alex,
                "holds": [{"hold_id": h, "role": "hand"} for h in holds]}
        if parent:
            data["parent_id"] = parent
        res = self.client.post("/api/routes", json=data)
        self.assertEqual(res.status_code, 201, res.get_json())
        return res.get_json()["id"]

    def listing(self, legacy=False):
        return self.client.get("/api/routes" + ("?legacy=1" if legacy else "")).get_json()

    # upload & edit ---------------------------------------------------------

    def test_upload_off_grid_hold(self):
        x, y = geometry.tnut_xy(27, 8)  # AB9
        hold = self.upload(x=x + 1.1, y=y - 0.7, size=5.5, rotation=30, name="Bison")
        self.assertEqual((hold["grid"], hold["name"], hold["size"], hold["rotation"]), ("AB9", "Bison", 5.5, 30))
        self.assertAlmostEqual(hold["offset"], 1.3, places=1)
        self.assertTrue(hold["image_url"].startswith("/uploads/holds/"))
        res = self.client.get(hold["image_url"])
        self.assertEqual((res.status_code, res.data[:8]), (200, b"\x89PNG\r\n\x1a\n"))
        res.close()
        self.assertEqual(len(os.listdir(self.upload_dir)), 1)

    def test_upload_suggests_name_when_blank(self):
        x, y = geometry.tnut_xy(27, 8)
        self.assertTrue(self.upload(x=x, y=y)["name"].startswith("B"))

    def test_upload_validation(self):
        x, y = geometry.tnut_xy(5, 3)  # column F
        self.upload(status=400, image=b"GIF89a not a png", x=x, y=y, name="Fern")
        self.upload(status=400, x=x, y=y, name="Badger")        # wrong letter
        self.upload(status=400, x=x, y=y, name="falcon")        # taken (case-insensitive)
        self.upload(status=400, x=-5, y=y, name="Fern")         # off the wall
        res = self.client.post("/api/holds", data={"x": x, "y": y}, content_type="multipart/form-data")
        self.assertEqual(res.status_code, 400)

    def test_upload_to_footboard(self):
        x, y = geometry.tnut_xy(2, 40)  # C′41
        self.upload(status=400, x=x + 2, y=y - 0.5, name="Falcon")   # footboard column C needs a C name
        hold = self.upload(x=x + 2, y=y - 0.5, name="Cedar")
        self.assertEqual(hold["grid"], "C\u203241")
        self.assertAlmostEqual(hold["offset"], (2 ** 2 + 0.5 ** 2) ** 0.5, places=2)
        self.upload(status=400, x=50, y=geometry.HEIGHT + 0.5, name="Quail")  # in the gap
        rid = self.route("Kick Start", [1, 2])
        res = self.client.put("/api/routes/%d" % rid, json={"holds": [
            {"hold_id": 1, "role": "start"}, {"hold_id": hold["id"], "role": "foot"}, {"hold_id": 2, "role": "finish"}]})
        self.assertEqual(res.status_code, 200)
        uses = self.client.get("/api/routes?hold_id=%d" % hold["id"]).get_json()
        self.assertEqual([r["id"] for r in uses], [rid])
        self.assertIn("foot", self.client.get("/api/board").get_json())

    def test_color_round_trip_and_validation(self):
        x, y = geometry.tnut_xy(5, 3)
        hold = self.upload(x=x, y=y, name="Fern", color="#A50606", color_opacity=0.4)
        self.assertEqual((hold["color"], hold["color_opacity"]), ("#a50606", 0.4))
        res = self.client.put("/api/holds/%d" % hold["id"], data={"color": "#1d4ed8", "color_opacity": "0.75"},
                              content_type="multipart/form-data")
        self.assertEqual((res.get_json()["color"], res.get_json()["color_opacity"]), ("#1d4ed8", 0.75))
        res = self.client.put("/api/holds/%d" % hold["id"], data={"color": ""}, content_type="multipart/form-data")
        self.assertIsNone(res.get_json()["color"])
        for bad in ({"color": "red"}, {"color": "#12345"}, {"color_opacity": "1.5"}):
            res = self.client.put("/api/holds/%d" % hold["id"], data=bad, content_type="multipart/form-data")
            self.assertEqual(res.status_code, 400, bad)

    def test_moving_a_hold_rechecks_name_letter(self):
        kx, ky = geometry.tnut_xy(1, 0)  # B1
        res = self.client.put("/api/holds/2", data={"x": kx, "y": ky}, content_type="multipart/form-data")
        self.assertEqual(res.status_code, 400)  # still called Falcon
        res = self.client.put("/api/holds/2", data={"x": kx, "y": ky, "name": "Badger"},
                              content_type="multipart/form-data")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json()["grid"], "B1")

    def test_attach_image_to_proxy_keeps_routes(self):
        rid = self.route("Crimson Gecko", [1, 2])
        res = self.client.put("/api/holds/2", data={"image": (io.BytesIO(png_bytes()), "f.png"), "size": "7"},
                              content_type="multipart/form-data")
        self.assertEqual(res.status_code, 200)
        self.assertIsNotNone(self.holds()[2]["image_url"])
        route = self.client.get("/api/routes/%d" % rid).get_json()
        self.assertEqual(sorted(h["hold_id"] for h in route["holds"]), [1, 2])
        # Replacing the image again deletes the previous file.
        self.client.put("/api/holds/2", data={"image": (io.BytesIO(png_bytes()), "g.png")},
                        content_type="multipart/form-data")
        self.assertEqual(len(os.listdir(self.upload_dir)), 1)

    # removal & legacy ------------------------------------------------------

    def test_removal_retires_or_greys_out(self):
        solo = self.route("Solo", [1, 2])                      # every climb uses hold 2
        base = self.route("Family", [1, 3])
        var_ok = self.route("Keeps", [1, 4], parent=base)
        var_gone = self.route("Loses", [2, 4], parent=base)

        impact = self.client.get("/api/holds/2/impact").get_json()
        self.assertEqual([r["name"] for r in impact["retired"]], ["Solo"])
        self.assertEqual(impact["partial"][0]["newly_impossible"], ["Family — Loses"])
        self.assertEqual(impact["partial"][0]["still_possible"], ["Family", "Family — Keeps"])

        self.assertEqual(self.client.delete("/api/holds/2").status_code, 200)
        self.assertTrue(self.holds()[2]["removed"])

        live = {r["id"]: r for r in self.listing()}
        self.assertNotIn(solo, live)
        self.assertEqual(live[base]["impossible_total"], 1)
        self.assertEqual({v["id"]: v["possible"] for v in live[base]["variations"]}, {var_ok: True, var_gone: False})
        self.assertEqual([r["id"] for r in self.listing(legacy=True)], [solo])

        detail = self.client.get("/api/routes/%d" % var_gone).get_json()
        self.assertEqual((detail["possible"], detail["legacy"], detail["removed_holds"]), (False, False, ["Falcon"]))
        self.assertTrue(self.client.get("/api/routes/%d" % solo).get_json()["legacy"])

        res = self.client.post("/api/sends", json={"route_id": solo, "climber_id": self.alex, "sent_date": "2026-09-09"})
        self.assertEqual(res.status_code, 400)

        self.assertEqual(self.client.post("/api/holds/2/restore").status_code, 200)
        self.assertEqual(sorted(r["id"] for r in self.listing()), sorted([solo, base]))
        self.assertEqual(self.listing(legacy=True), [])

    def test_names_are_unique_across_all_holds(self):
        x, y = geometry.tnut_xy(5, 3)
        self.assertEqual(self.upload(400, x=x, y=y, name="falcon")["error"], "Another hold is already called falcon")
        # A removed hold keeps its name, so it can come back as it was.
        self.client.delete("/api/holds/2")
        self.assertEqual(self.upload(400, x=x, y=y, name="Falcon")["error"],
                         "A removed hold is already called Falcon. Delete it permanently to reuse the name")
        res = self.client.put("/api/holds/3", data={"x": x, "y": y, "name": "Falcon"}, content_type="multipart/form-data")
        self.assertEqual(res.status_code, 400)
        suggested = [self.upload(x=x, y=y)["name"] for _ in range(3)]
        self.assertNotIn("falcon", [n.lower() for n in suggested])
        restored = self.client.post("/api/holds/2/restore").get_json()
        self.assertEqual((restored["removed"], restored["name"]), (False, "Falcon"))
        # Deleting it for good frees the name.
        self.client.delete("/api/holds/2")
        self.assertEqual(self.client.delete("/api/holds/2/permanent").status_code, 200)
        self.assertEqual(self.upload(x=x, y=y, name="Falcon")["name"], "Falcon")
        # The database refuses a duplicate too, whatever the case.
        conn = db.connect(self.db_path)
        with self.assertRaises(sqlite3.IntegrityError):
            conn.execute("UPDATE holds SET name = 'KITE' WHERE id = 1")
        conn.close()

    def test_delete_permanently(self):
        hold = self.upload(x=geometry.tnut_xy(5, 3)[0], y=geometry.tnut_xy(5, 3)[1], name="Ferret")
        url = "/api/holds/%d/permanent" % hold["id"]
        # Only once it's off the wall.
        self.assertEqual(self.client.delete(url).status_code, 400)
        self.client.delete("/api/holds/%d" % hold["id"])
        self.assertEqual(len(os.listdir(self.upload_dir)), 1)
        res = self.client.delete(url)
        self.assertEqual((res.status_code, res.get_json()), (200, {"deleted": hold["id"]}))
        self.assertNotIn(hold["id"], self.holds())
        self.assertEqual(os.listdir(self.upload_dir), [])
        self.assertEqual(self.client.delete(url).status_code, 404)

    def test_delete_permanently_refused_while_climbs_use_it(self):
        solo = self.route("Solo", [1, 2])
        self.client.delete("/api/holds/2")
        res = self.client.delete("/api/holds/2/permanent")
        self.assertEqual(res.status_code, 400)
        self.assertIn("Solo", res.get_json()["error"])
        self.assertIn(2, self.holds())
        self.assertEqual(self.client.get("/api/routes/%d" % solo).get_json()["removed_holds"], ["Falcon"])
        # Once the legacy climb is gone, the hold can go.
        self.client.delete("/api/routes/%d" % solo)
        self.assertEqual(self.client.delete("/api/holds/2/permanent").status_code, 200)
        self.assertNotIn(2, self.holds())

    def test_removed_holds_cannot_be_used_in_new_routes(self):
        rid = self.route("Old", [1, 2])
        self.client.delete("/api/holds/2")
        res = self.client.post("/api/routes", json={"name": "New", "grade": "easy", "set_date": "2026-09-01",
                                                    "holds": [{"hold_id": 2, "role": "hand"}]})
        self.assertEqual(res.status_code, 400)
        # Editing the legacy route may keep its removed hold...
        res = self.client.put("/api/routes/%d" % rid, json={"name": "Old (renamed)",
                                                           "holds": [{"hold_id": 1, "role": "start"}, {"hold_id": 2, "role": "finish"}]})
        self.assertEqual(res.status_code, 200)
        # ...and swapping it out brings the route back.
        self.client.put("/api/routes/%d" % rid, json={"holds": [{"hold_id": 1, "role": "start"}, {"hold_id": 3, "role": "finish"}]})
        self.assertIn(rid, [r["id"] for r in self.listing()])

    def test_logbook_flags_impossible_climbs(self):
        rid = self.route("Old", [1, 2])
        self.client.post("/api/sends", json={"route_id": rid, "climber_id": self.alex, "sent_date": "2026-09-09"})
        self.client.delete("/api/holds/2")
        log = self.client.get("/api/climbers/%d/sends" % self.alex).get_json()
        self.assertFalse(log["sends"][0]["possible"])


class MigrationTest(unittest.TestCase):
    def test_old_database_gains_columns_and_names(self):
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        try:
            conn = sqlite3.connect(path)
            conn.executescript("""
                CREATE TABLE holds (id INTEGER PRIMARY KEY, x REAL NOT NULL, y REAL NOT NULL,
                                    tnut_col INTEGER, tnut_row INTEGER, shape TEXT,
                                    created_at TEXT NOT NULL DEFAULT (datetime('now')));
            """)
            for col, row in [(0, 0), (27, 4), (27, 9), (39, 38)]:
                conn.execute("INSERT INTO holds (x, y, tnut_col, tnut_row) VALUES (?, ?, ?, ?)",
                             geometry.tnut_xy(col, row) + (col, row))
            conn.execute("INSERT INTO holds (x, y) VALUES (60.2, 30.1)")  # off-grid, no t-nut recorded
            conn.commit()
            conn.close()

            conn = db.connect(path)
            db.init_db(conn)
            holds = conn.execute("SELECT * FROM holds ORDER BY id").fetchall()
            self.assertEqual([geometry.name_letter(h["tnut_col"]) for h in holds], [h["name"][0] for h in holds])
            self.assertEqual([h["name"][0] for h in holds[:4]], ["A", "B", "B", "N"])
            self.assertEqual(len({h["name"] for h in holds}), 5)
            self.assertEqual(holds[0]["size"], 6)
            self.assertIsNotNone(holds[4]["tnut_col"])
            conn.close()
        finally:
            os.remove(path)

    def test_old_database_loses_duplicate_names(self):
        """Older databases kept names unique only on the wall: the hold on the
        wall keeps a shared name and the removed one gets a new one."""
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        try:
            conn = db.connect(path)
            with open(db.SCHEMA_PATH) as f:
                conn.executescript(f.read())
            for name, col, removed in [("Falcon", 5, "2026-01-01"), ("falcon", 5, None), ("Kite", 10, "2026-01-02"),
                                       ("Kite", 10, "2026-01-03"), ("Anchor", 0, None)]:
                x, y = geometry.tnut_xy(col, 3)
                conn.execute("INSERT INTO holds (name, x, y, tnut_col, tnut_row, removed_at) VALUES (?, ?, ?, ?, 3, ?)",
                             (name, x, y, col, removed))
            conn.commit()
            db.init_db(conn)
            names = [r["name"] for r in conn.execute("SELECT name FROM holds ORDER BY id")]
            self.assertEqual(names[1], "falcon")                    # on the wall: keeps it
            self.assertNotEqual(names[0].lower(), "falcon")
            self.assertTrue(names[0].startswith("F"))
            self.assertEqual(names[2], "Kite")                      # both removed: the older keeps it
            self.assertTrue(names[3].startswith("K") and names[3] != "Kite")
            self.assertEqual(len({n.lower() for n in names}), 5)
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute("UPDATE holds SET name = 'ANCHOR' WHERE id = 2")
            conn.close()
        finally:
            os.remove(path)


if __name__ == "__main__":
    unittest.main()
