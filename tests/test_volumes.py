import unittest

from support import ApiTestCase, ScratchTestCase

import db
import geometry
from app import create_app


TRIANGLE = [[40.5, 30.25], [55.1, 31.0], [47.3, 44.8]]
SQUARE = [[30, 30], [50, 30], [50, 50], [30, 50]]


class VolumeApiTest(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.add_holds([("Falcon", 5, 11)])

    def create(self, points, color="black", status=201):
        res = self.client.post("/api/volumes", json={"points": points, "color": color})
        self.assertEqual(res.status_code, status, res.get_json())
        return res.get_json()

    def test_create_list_recolor_delete(self):
        volume = self.create(TRIANGLE + [[41.0, 40.0]], color="green")
        self.assertEqual(volume["color"], "green")
        self.assertEqual(len(volume["points"]), 4)
        self.assertEqual(self.client.get("/api/volumes").get_json(), [volume])

        res = self.client.put("/api/volumes/%d" % volume["id"], json={"color": "black"})
        self.assertEqual((res.status_code, res.get_json()["color"]), (200, "black"))
        self.assertEqual(res.get_json()["points"], volume["points"])

        res = self.client.put("/api/volumes/%d" % volume["id"], json={"points": TRIANGLE})
        self.assertEqual(len(res.get_json()["points"]), 3)

        self.assertEqual(self.client.delete("/api/volumes/%d" % volume["id"]).status_code, 200)
        self.assertEqual(self.client.get("/api/volumes").get_json(), [])
        self.assertEqual(self.client.delete("/api/volumes/%d" % volume["id"]).status_code, 404)

    def test_points_are_rounded(self):
        volume = self.create([[10.12345, 10.0], [20.0, 10.98765], [15.5, 20.0]])
        self.assertEqual(volume["points"][0], [10.12, 10.0])
        self.assertEqual(volume["points"][1], [20.0, 10.99])

    def test_validation(self):
        self.create(TRIANGLE, color="red", status=400)
        self.create(TRIANGLE, color=None, status=400)
        self.create(TRIANGLE[:2], status=400)                                     # too few corners
        self.create([[10, 10]] * 101, status=400)                                 # too many
        self.create(TRIANGLE[:2] + [[130.0, 40.0]], status=400)                   # off the wall
        self.create(TRIANGLE[:2] + [[50.0, geometry.HEIGHT + 0.5]], status=400)   # in the gap
        self.create(TRIANGLE[:2] + [["a", 3]], status=400)                        # not a number
        self.create(TRIANGLE[:2] + [[1, 2, 3]], status=400)                       # not a pair
        self.create("nope", status=400)
        res = self.client.put("/api/volumes/999", json={"color": "black"})
        self.assertEqual(res.status_code, 404)

    def test_volume_stays_on_one_panel(self):
        foot = geometry.FOOT_TOP
        self.create([[10, foot + 1], [30, foot + 1], [20, foot + 7]])                 # footboard only: fine
        self.create([[10, geometry.HEIGHT - 1], [30, foot + 1], [20, foot + 7]], status=400)

    def test_volumes_on_side_panels(self):
        self.create([[-8, 10], [-2, 10], [-5, 20]])                              # left panel
        right = self.create([[122, 10], [128, 10], [125, 20]])                   # right panel
        self.create([[110, 10], [125, 10], [115, 20]], status=400)               # main and right
        self.create([[-5, 10], [5, 10], [0, 20]], status=400)                    # left and main
        res = self.client.put("/api/volumes/%d" % right["id"], json={"faces": [[[122, 10], [128, 10], [5, 20]]]})
        self.assertEqual(res.status_code, 400)                                    # a face off its panel

    def test_no_volumes_on_the_ceiling(self):
        self.create([[40, -15], [60, -15], [50, -5]], status=400)                 # ceiling
        self.create([[40, -5], [60, -5], [50, 5]], status=400)                    # ceiling and main

    def test_volumes_are_not_holds(self):
        self.create(TRIANGLE)
        holds = self.client.get("/api/holds").get_json()
        self.assertEqual([h["name"] for h in holds], ["Falcon"])

    def test_faces(self):
        volume = self.create(SQUARE)
        self.assertEqual(volume["faces"], [])
        url = "/api/volumes/%d" % volume["id"]
        faces = [[[30, 30], [50, 30], [40.004, 40]], [[50, 50], [30, 50], [40, 40]]]
        res = self.client.put(url, json={"faces": faces})
        self.assertEqual(res.status_code, 200, res.get_json())
        self.assertEqual(res.get_json()["faces"], [[[30, 30], [50, 30], [40.0, 40]], [[50, 50], [30, 50], [40, 40]]])
        self.assertEqual(res.get_json()["points"], SQUARE)
        # Changing only the outline (or color) keeps the faces.
        res = self.client.put(url, json={"points": SQUARE[:3] + [[29, 51]], "color": "green"})
        self.assertEqual(len(res.get_json()["faces"]), 2)
        self.assertEqual(self.client.get("/api/volumes").get_json()[0]["faces"], res.get_json()["faces"])
        # Faces can come with a new volume, too.
        made = self.client.post("/api/volumes", json={"points": SQUARE, "color": "black", "faces": faces[:1]}).get_json()
        self.assertEqual(len(made["faces"]), 1)

    def test_face_validation(self):
        url = "/api/volumes/%d" % self.create(SQUARE)["id"]

        def put(faces):
            return self.client.put(url, json={"faces": faces}).status_code

        self.assertEqual(put([[[30, 30], [50, 30]]]), 400)                                   # too few corners
        self.assertEqual(put([[[30, 30], [50, 30], [40, geometry.FOOT_TOP + 2]]]), 400)      # off its panel
        self.assertEqual(put([[[30, 30], [50, 30], [1, 2, 3]]]), 400)                         # not a pair
        self.assertEqual(put("nope"), 400)
        self.assertEqual(put([[[30, 30], [50, 30], [40, 40]]] * 51), 400)                    # too many
        self.assertEqual(put([]), 200)


class VolumeMigrationTest(ScratchTestCase):
    def test_old_database_gains_faces(self):
        path = self.scratch("test.db")
        conn = db.connect(path)
        conn.execute("""CREATE TABLE volumes (id INTEGER PRIMARY KEY, points TEXT NOT NULL,
                        color TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))""")
        conn.execute("INSERT INTO volumes (points, color) VALUES (?, 'black')", ('[[30, 30], [50, 30], [40, 45]]',))
        conn.commit()
        conn.close()
        client = create_app(path, self.scratch("uploads")).test_client()
        self.assertEqual(client.get("/api/volumes").get_json()[0]["faces"], [])


if __name__ == "__main__":
    unittest.main()
