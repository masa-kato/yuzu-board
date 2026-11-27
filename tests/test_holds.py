import io
import os
import sqlite3
import struct
import unittest
import zlib

from PIL import Image

from support import ApiTestCase, ScratchTestCase

import db
import geometry
import hold_names


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
        self.assertIsNone(geometry.panel_of(50, geometry.HEIGHT + 0.5))
        self.assertEqual(geometry.panel_of(50, geometry.FOOT_TOP + 4), "foot")

    def test_side_panels(self):
        # 8" wide, 1" either side of the main panel, from the top of the wall
        # to the bottom of the main panel (not beside the footboard).
        self.assertEqual((geometry.LEFT_X, geometry.RIGHT_X, geometry.MAX_X), (-9.0, 121.0, 129.0))
        self.assertEqual(geometry.panel_of(-5, 50), "left")
        self.assertEqual(geometry.panel_of(125, 50), "right")
        self.assertEqual(geometry.panel_of(-9, 0), "left")                    # edges count
        self.assertEqual(geometry.panel_of(129, geometry.HEIGHT), "right")
        for x, y in [(-0.5, 50), (120.5, 50), (-9.5, 50), (129.5, 50),       # gaps, past the edges
                     (-5, geometry.HEIGHT + 0.5), (-5, geometry.FOOT_TOP + 4), (125, -1)]:
            self.assertIsNone(geometry.panel_of(x, y), (x, y))
        self.assertEqual((geometry.hold_letter(-5, 50), geometry.hold_letter(125, 50)), ("L", "R"))
        x, y = geometry.tnut_xy(5, 11)
        self.assertEqual(geometry.hold_letter(x + 1, y), "F")
        self.assertEqual(geometry.hold_grid(-5, 50, None, None), "Left panel")
        self.assertEqual(geometry.hold_grid(x, y, 5, 11), "F12")
        spec = geometry.board_spec()
        self.assertEqual((spec["min_x"], spec["max_x"]), (-9.0, 129.0))
        self.assertEqual(spec["sides"]["letters"], {"left": "L", "right": "R"})

    def test_ceiling(self):
        # 18" high, 1" above the main panel and as wide as it.
        self.assertEqual((geometry.CEIL_TOP, geometry.CEIL_BOTTOM, geometry.MIN_Y), (-19.0, -1.0, -19.0))
        self.assertEqual(geometry.panel_of(50, -10), "ceiling")
        self.assertEqual(geometry.panel_of(0, -19), "ceiling")                # edges count
        self.assertEqual(geometry.panel_of(120, -1), "ceiling")
        for x, y in [(50, -0.5), (50, -19.5), (-0.5, -10), (120.5, -10),      # gap, past the edges
                     (-5, -10), (125, -10)]:                                  # not over the side panels
            self.assertIsNone(geometry.panel_of(x, y), (x, y))
        self.assertTrue(geometry.tnut_free(50, -10))
        self.assertFalse(geometry.tnut_free(50, 10))
        # The columns carry on across it: a hold takes the letter of the one it's under.
        f = geometry.tnut_xy(5, 0)[0]
        self.assertEqual(geometry.hold_letter(f + 1, -10), "F")
        self.assertEqual(geometry.hold_letter(geometry.tnut_xy(28, 0)[0], -18), "C")   # AC
        self.assertEqual(geometry.hold_grid(f + 1, -10, None, None), "Ceiling, column F")
        spec = geometry.board_spec()
        self.assertEqual((spec["min_y"], spec["ceiling"]["top"], spec["ceiling"]["height"]), (-19.0, -19.0, 18.0))

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


class HoldApiTest(ApiTestCase):
    def setUp(self):
        super().setUp()
        conn = db.connect(self.db_path)
        # Proxy holds at A1, F12, K20 and P30.
        for col, row, name in [(0, 0, "Anchor"), (5, 11, "Falcon"), (10, 19, "Kite"), (15, 29, "Pebble")]:
            x, y = geometry.tnut_xy(col, row)
            conn.execute("INSERT INTO holds (name, x, y, tnut_col, tnut_row) VALUES (?, ?, ?, ?, ?)",
                         (name, x, y, col, row))
        conn.commit()
        conn.close()
        self.alex = self.client.post("/api/climbers", json={"name": "Alex"}).get_json()["id"]

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
        self.upload(status=400, x=-0.5, y=y, name="Fern")       # in the gap beside the main panel
        self.upload(status=400, x=-9.5, y=y, name="Fern")       # past the left panel
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

    def test_upload_to_side_panels(self):
        hold = self.upload(x=-5, y=40, name="Lantern")
        self.assertEqual((hold["panel"], hold["grid"], hold["offset"]), ("left", "Left panel", None))
        self.assertEqual((hold["tnut_col"], hold["tnut_row"]), (None, None))
        hold = self.upload(x=125, y=40, name="Raven")
        self.assertEqual((hold["panel"], hold["grid"], hold["offset"]), ("right", "Right panel", None))
        self.assertTrue(self.upload(x=-5, y=80)["name"].startswith("L"))      # suggested
        error = self.upload(status=400, x=-5, y=60, name="Falcon")["error"]   # needs an L name
        self.assertIn("left panel", error)
        self.upload(status=400, x=-5, y=geometry.FOOT_TOP + 4, name="Lemur")  # nothing beside the footboard
        # A route can use a side-panel hold.
        rid = self.route("Wide Load", [1, hold["id"]])
        self.assertEqual([r["id"] for r in self.client.get("/api/routes?hold_id=%d" % hold["id"]).get_json()], [rid])

    def test_upload_to_ceiling(self):
        x = geometry.tnut_xy(5, 0)[0] + 1   # over column F
        hold = self.upload(x=x, y=-10, name="Fern")
        self.assertEqual((hold["panel"], hold["grid"], hold["offset"]), ("ceiling", "Ceiling, column F", None))
        self.assertEqual((hold["tnut_col"], hold["tnut_row"]), (None, None))
        self.assertTrue(self.upload(x=x, y=-4)["name"].startswith("F"))       # suggested
        error = self.upload(status=400, x=x, y=-15, name="Lantern")["error"]  # needs an F name
        self.assertIn("column F on the ceiling", error)
        self.upload(status=400, x=x, y=-0.5, name="Fig")                       # in the gap
        self.upload(status=400, x=x, y=-19.5, name="Fig")                      # past the top
        self.upload(status=400, x=-5, y=-10, name="Lemur")                     # nothing over the side panels
        rid = self.route("Roof Problem", [1, hold["id"]])
        self.assertEqual([r["id"] for r in self.client.get("/api/routes?hold_id=%d" % hold["id"]).get_json()], [rid])

    def test_moving_a_hold_to_a_side_panel_and_back(self):
        res = self.client.put("/api/holds/2", data={"x": 125, "y": 40, "name": "Rocket"},
                              content_type="multipart/form-data")
        self.assertEqual(res.status_code, 200, res.get_json())
        self.assertEqual((res.get_json()["grid"], res.get_json()["tnut_col"]), ("Right panel", None))
        x, y = geometry.tnut_xy(5, 11)
        res = self.client.put("/api/holds/2", data={"x": x, "y": y, "name": "Falcon"},
                              content_type="multipart/form-data")
        self.assertEqual((res.get_json()["grid"], res.get_json()["offset"]), ("F12", 0))

    def test_color_round_trip_and_validation(self):
        x, y = geometry.tnut_xy(5, 3)
        hold = self.upload(x=x, y=y, name="Fern", color="#A50606")
        self.assertEqual(hold["color"], "#a50606")
        self.assertNotIn("color_opacity", hold)   # one opacity for every hold, set in the browser
        res = self.client.put("/api/holds/%d" % hold["id"], data={"color": "#1d4ed8"},
                              content_type="multipart/form-data")
        self.assertEqual(res.get_json()["color"], "#1d4ed8")
        res = self.client.put("/api/holds/%d" % hold["id"], data={"color": ""}, content_type="multipart/form-data")
        self.assertIsNone(res.get_json()["color"])
        for bad in ({"color": "red"}, {"color": "#12345"}):
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

    # board images ----------------------------------------------------------

    def get_png_size(self, url):
        res = self.client.get(url)
        self.assertEqual(res.status_code, 200)
        self.assertGreaterEqual(res.cache_control.max_age, 30 * 24 * 3600)
        size = struct.unpack(">II", res.data[16:24])
        res.close()
        return size

    def board_copies(self):
        board_dir = os.path.join(self.upload_dir, "board")
        return sorted(os.listdir(board_dir)) if os.path.isdir(board_dir) else []

    def test_board_image_is_a_smaller_copy(self):
        x, y = geometry.tnut_xy(5, 3)
        hold = self.upload(image=png_bytes(400, 300), x=x, y=y, size=2, name="Ferret")
        self.assertEqual(self.get_png_size(hold["image_url"]), (400, 300))
        # 64 px per inch of the hold's size: 2" gets 128 px on its longest side.
        self.assertTrue(hold["board_url"].endswith("-128.png"), hold["board_url"])
        self.assertEqual(self.get_png_size(hold["board_url"]), (128, 96))
        self.assertEqual(len(self.board_copies()), 1)
        # Resizing the hold asks for another copy, rounded up to 32 px steps.
        res = self.client.put("/api/holds/%d" % hold["id"], json={"size": 3.1})
        self.assertTrue(res.get_json()["board_url"].endswith("-224.png"))
        # Never larger than the original, nor smaller than the minimum.
        res = self.client.put("/api/holds/%d" % hold["id"], json={"size": 30})
        self.assertEqual(self.get_png_size(res.get_json()["board_url"]), (400, 300))
        res = self.client.put("/api/holds/%d" % hold["id"], json={"size": 0.5})
        self.assertTrue(res.get_json()["board_url"].endswith("-96.png"))
        # Placeholder holds have no image.
        self.assertIsNone(self.holds()[1]["board_url"])

    def test_extent_follows_the_image(self):
        x, y = geometry.tnut_xy(5, 3)
        hold = self.upload(image=png_bytes(400, 300), x=x, y=y, size=2, name="Ferret")
        # The image fitted to the hold's size on its longest side.
        self.assertEqual(hold["extent"], [2.0, 1.5])
        res = self.client.put("/api/holds/%d" % hold["id"], json={"size": 4})
        self.assertEqual(res.get_json()["extent"], [4.0, 3.0])
        tall = self.upload(image=png_bytes(30, 90), x=x, y=y + 3, size=3, name="Fox")
        self.assertEqual(tall["extent"], [1.0, 3.0])
        # Placeholder holds have none, nor does a hold whose image is gone.
        conn = db.connect(self.db_path)
        conn.execute("UPDATE holds SET image = ? WHERE id = ?", ("0" * 32 + ".png", tall["id"]))
        conn.commit()
        conn.close()
        holds = self.holds()
        self.assertIsNone(holds[1]["extent"])
        self.assertIsNone(holds[tall["id"]]["extent"])

    def test_board_images_sized_for_the_screen(self):
        x, y = geometry.tnut_xy(5, 3)
        hold_id = self.upload(image=png_bytes(800, 600), x=x, y=y, size=6, name="Ferret")["id"]

        def board_url(query=""):
            holds = self.client.get("/api/holds" + query).get_json()
            return next(h for h in holds if h["id"] == hold_id)["board_url"]

        # The smallest density on offer that covers what the screen asked for:
        # 6" at 24 px per inch is 144 px, rounded up to 160.
        self.assertTrue(board_url("?ppi=22").endswith("-160.png"))
        self.assertTrue(board_url("?ppi=24").endswith("-160.png"))
        self.assertTrue(board_url("?ppi=25").endswith("-192.png"))     # 32 px per inch
        self.assertTrue(board_url("?ppi=40").endswith("-288.png"))     # 48
        # More than the largest, nothing, or nonsense: the largest (64).
        for query in ["?ppi=200", "", "?ppi=lots", "?ppi=nan"]:
            self.assertTrue(board_url(query).endswith("-384.png"), query)
        self.assertEqual(self.get_png_size(board_url("?ppi=22")), (160, 120))

    def test_board_image_names_are_checked(self):
        x, y = geometry.tnut_xy(5, 3)
        stem = self.upload(x=x, y=y, name="Ferret")["image_url"].rsplit("/", 1)[1][:-4]
        for name in ["%s-100.png" % stem, "%s-64.png" % stem, "%s-4096.png" % stem,
                     "%s.png" % stem, "%s-128.png" % ("0" * 32), "..%2f..%2fapp.py"]:
            res = self.client.get("/uploads/holds/board/" + name)
            self.assertEqual(res.status_code, 404, name)
            res.close()
        self.assertEqual(self.board_copies(), [])

    def test_board_copies_go_with_their_image(self):
        x, y = geometry.tnut_xy(5, 3)
        hold = self.upload(x=x, y=y, name="Ferret")
        self.client.get(hold["board_url"]).close()
        self.assertEqual(len(self.board_copies()), 1)
        # Replacing the image deletes the old one's copies.
        res = self.client.put("/api/holds/%d" % hold["id"], data={"image": (io.BytesIO(png_bytes()), "g.png")},
                              content_type="multipart/form-data")
        self.client.get(res.get_json()["board_url"]).close()
        self.assertEqual(self.board_copies(), [res.get_json()["board_url"].rsplit("/", 1)[1]])
        # So does deleting the hold for good.
        self.client.delete("/api/holds/%d" % hold["id"])
        self.client.delete("/api/holds/%d/permanent" % hold["id"])
        self.assertEqual(self.board_copies(), [])

    def test_touch_screen_looks(self):
        """Touch screens draw holds from ready-made looks of the board copy
        (board.js LIGHT), each as big as the copy is drawn."""
        solid = io.BytesIO()
        Image.new("RGBA", (40, 30), (200, 60, 60, 255)).save(solid, "PNG")
        x, y = geometry.tnut_xy(5, 3)
        hold = self.upload(image=solid.getvalue(), x=x, y=y, size=2, name="Ferret")
        base = hold["board_url"][:-4]   # ...-128: a 40 px image, drawn 128 px across

        def pixels(suffix):
            res = self.client.get("%s-%s.png" % (base, suffix))
            self.assertEqual(res.status_code, 200, suffix)
            self.assertGreaterEqual(res.cache_control.max_age, 30 * 24 * 3600)
            im = Image.open(io.BytesIO(res.data)).convert("RGBA")
            res.close()
            return im

        shape = pixels("s")                        # black, scaled up to the drawn size
        self.assertEqual((shape.size, shape.getpixel((64, 48))), ((128, 96), (0, 0, 0, 255)))
        border = pixels("o5")                      # with 5 px of border all round
        self.assertEqual(border.size, (138, 106))
        self.assertEqual(border.getpixel((69, 53)), (200, 60, 60, 255))   # the hold
        self.assertEqual(border.getpixel((2, 53)), (255, 255, 255, 230))  # its border, at 0.9
        self.assertEqual(border.getpixel((0, 0))[3], 0)                   # rounded at the corners
        # #1e3a8a laid over the hold at 75%, on its own or inside the border.
        tinted = (200 * 0.25 + 0x1e * 0.75, 60 * 0.25 + 0x3a * 0.75, 60 * 0.25 + 0x8a * 0.75, 255)
        for suffix, size, middle in [("t1e3a8a75", (128, 96), (64, 48)), ("o5t1e3a8a75", (138, 106), (69, 53))]:
            im = pixels(suffix)
            self.assertEqual(im.size, size)
            for got, want in zip(im.getpixel(middle), tinted):
                self.assertAlmostEqual(got, want, delta=1)
        self.assertEqual(pixels("o5t1e3a8a75").getpixel((2, 53)), (255, 255, 255, 230))   # border untinted
        self.assertEqual(len(self.board_copies()), 4)
        for suffix in ["o0", "o25", "o", "x", "c1e3a8a", "t1e3a8a", "t1e3a8a101", "o5t", "o5s",
                       "T1E3A8A75", "s-s"]:
            res = self.client.get("%s-%s.png" % (base, suffix))
            self.assertEqual(res.status_code, 404, suffix)
            res.close()
        self.assertEqual(len(self.board_copies()), 4)
        # They go with the image, as the copy does.
        self.client.delete("/api/holds/%d" % hold["id"])
        self.client.delete("/api/holds/%d/permanent" % hold["id"])
        self.assertEqual(self.board_copies(), [])

    def picture(self, status=200, ppi=12, border=2, tint=0):
        res = self.client.get("/api/holds/picture?ppi=%s&border=%s&tint=%s" % (ppi, border, tint))
        self.assertEqual(res.status_code, status, res.get_json())
        return res.get_json()

    def picture_image(self, url):
        res = self.client.get(url)
        self.assertEqual((res.status_code, res.mimetype), (200, "image/webp"))
        self.assertGreaterEqual(res.cache_control.max_age, 30 * 24 * 3600)
        im = Image.open(io.BytesIO(res.data)).convert("RGBA")
        res.close()
        return im

    def test_wall_picture(self):
        """Touch screens draw every hold on the wall from one picture
        (board.js LIGHT), made by the server."""
        def solid(w, h, rgb=(200, 60, 60)):
            out = io.BytesIO()
            Image.new("RGBA", (w, h), rgb + (255,)).save(out, "PNG")
            return out.getvalue()

        def at(pic, x, y):   # wall inches to picture pixels
            return round((x - geometry.MIN_X) * 12), round((y - geometry.MIN_Y) * 12)

        x, y = geometry.tnut_xy(4, 10)    # E11, a bolt hole ((4 + 10) is even)
        hold = self.upload(image=solid(40, 40), x=x, y=y, size=3)
        bx, by = geometry.tnut_xy(20, 20)  # a bar, 6" by 1", turned upright
        bar = self.upload(image=solid(60, 10, (30, 90, 200)), x=bx, y=by, size=6, rotation=90)
        pic = self.picture()
        self.assertEqual((pic["x"], pic["y"], pic["width"], pic["height"]),
                         (geometry.MIN_X, geometry.MIN_Y, geometry.MAX_X - geometry.MIN_X, geometry.TOTAL_HEIGHT - geometry.MIN_Y))
        im = self.picture_image(pic["url"])
        self.assertEqual(im.size, (round(pic["width"] * 12), round(pic["height"] * 12)))
        # Each hold where it sits, in its color (lossy, so roughly); the bar upright.
        for (px, py), rgb in [(at(pic, x, y), (200, 60, 60)), (at(pic, bx, by - 2.5), (30, 90, 200))]:
            r, g, b, a = im.getpixel((px, py))
            self.assertEqual(a, 255)
            for got, want in zip((r, g, b), rgb):
                self.assertAlmostEqual(got, want, delta=16)
        self.assertEqual(im.getpixel(at(pic, bx + 2.5, by))[3], 0)   # not lying across
        self.assertEqual(im.getpixel(at(pic, 60, 60))[3], 0)         # bare wall
        # The bolt hole under the hold is covered; one in the open isn't.
        holes = geometry.bolt_holes()
        self.assertIn(holes.index((x, y)), pic["covered"])
        self.assertNotIn(holes.index(geometry.tnut_xy(30, 30)), pic["covered"])

        # The same holds give the same picture, not drawn again.
        board_dir = os.path.join(self.upload_dir, "board")
        made = os.path.getmtime(os.path.join(board_dir, pic["url"].rsplit("/", 1)[1]))
        self.assertEqual(self.picture()["url"], pic["url"])
        self.assertEqual(os.path.getmtime(os.path.join(board_dir, pic["url"].rsplit("/", 1)[1])), made)
        # Moving, recoloring or removing a hold gives a new one.
        urls = {pic["url"]}
        self.client.put("/api/holds/%d" % hold["id"], data={"x": x + 1, "y": y},
                        content_type="multipart/form-data")
        urls.add(self.picture()["url"])
        self.client.put("/api/holds/color", json={"hold_ids": [hold["id"]], "color": "#1e3a8a"})
        urls.add(self.picture()["url"])
        self.client.delete("/api/holds/%d" % bar["id"])
        removed = self.picture()
        urls.add(removed["url"])
        self.assertEqual(len(urls), 4)
        self.assertEqual(self.picture_image(removed["url"]).getpixel(at(removed, bx, by))[3], 0)

        for params in [{"ppi": 13}, {"ppi": "x"}, {"border": 0}, {"border": 17}, {"tint": 7}, {"tint": 105}]:
            self.picture(status=400, **params)
        # Only the newest few are kept.
        for tint in range(0, 55, 5):
            self.picture(tint=tint)
        self.assertLessEqual(len([n for n in os.listdir(board_dir) if n.startswith("wall-") and n.endswith(".webp")]), 8)
        self.client.get("/uploads/holds/board/wall-%s.webp" % ("0" * 20)).close()
        self.assertEqual(self.client.get("/uploads/holds/board/wall-%s.webp" % ("0" * 20)).status_code, 404)

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


class MigrationTest(ScratchTestCase):
    def test_old_database_gains_columns_and_names(self):
        path = self.scratch("test.db")
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

    def test_old_database_loses_retired_column_and_index(self):
        """`color_opacity` and the on-the-wall-only name index are dropped,
        keeping every hold."""
        path = self.scratch("test.db")
        conn = db.connect(path)
        with open(db.SCHEMA_PATH) as f:
            conn.executescript(f.read().replace(
                "    color          TEXT,\n", "    color          TEXT,\n    color_opacity  REAL NOT NULL DEFAULT 0.5,\n"))
        conn.execute("CREATE UNIQUE INDEX idx_holds_active_name ON holds(name COLLATE NOCASE) WHERE removed_at IS NULL")
        x, y = geometry.tnut_xy(5, 3)
        conn.execute("INSERT INTO holds (name, x, y, tnut_col, tnut_row, color, color_opacity) VALUES ('Fern', ?, ?, 5, 3, '#a50606', 0.4)",
                     (x, y))
        conn.commit()
        db.init_db(conn)
        if sqlite3.sqlite_version_info >= (3, 35, 0):
            self.assertNotIn("color_opacity", [r["name"] for r in conn.execute("PRAGMA table_info(holds)")])
        self.assertIsNone(conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'idx_holds_active_name'").fetchone())
        self.assertEqual(tuple(conn.execute("SELECT name, color FROM holds").fetchone()), ("Fern", "#a50606"))
        conn.close()

    def test_side_holds_keep_no_tnut(self):
        """Startup gives holds without a t-nut their nearest one, but not holds
        on a side panel; a duplicate name there is replaced with an L or R noun."""
        path = self.scratch("test.db")
        conn = db.connect(path)
        db.init_db(conn)
        conn.execute("INSERT INTO holds (name, x, y, removed_at) VALUES ('Lantern', -5, 40, '2026-01-01')")
        conn.execute("INSERT INTO holds (name, x, y) VALUES ('Rocket', 125, 40)")
        conn.commit()
        conn.execute("DROP INDEX idx_holds_name")   # as in a database from before names were unique
        conn.execute("INSERT INTO holds (name, x, y) VALUES ('lantern', 125, 60)")
        conn.commit()
        db.init_db(conn)
        holds = conn.execute("SELECT name, tnut_col, tnut_row FROM holds ORDER BY id").fetchall()
        self.assertEqual([(h["tnut_col"], h["tnut_row"]) for h in holds], [(None, None)] * 3)
        self.assertEqual([h["name"] for h in holds[1:]], ["Rocket", "lantern"])   # on the wall: keeps it
        self.assertTrue(holds[0]["name"].startswith("L") and holds[0]["name"] != "Lantern")
        conn.close()

    def test_ceiling_holds_keep_no_tnut(self):
        path = self.scratch("test.db")
        conn = db.connect(path)
        db.init_db(conn)
        conn.execute("INSERT INTO holds (name, x, y) VALUES ('Fern', ?, -10)", (geometry.tnut_xy(5, 0)[0],))
        conn.commit()
        db.init_db(conn)
        hold = conn.execute("SELECT tnut_col, tnut_row FROM holds").fetchone()
        self.assertEqual((hold["tnut_col"], hold["tnut_row"]), (None, None))
        conn.close()

    def test_old_database_loses_duplicate_names(self):
        """Older databases kept names unique only on the wall: the hold on the
        wall keeps a shared name and the removed one gets a new one."""
        path = self.scratch("test.db")
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


if __name__ == "__main__":
    unittest.main()
