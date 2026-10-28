import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import db  # noqa: E402
import geometry  # noqa: E402
from app import create_app  # noqa: E402


class CircuitApiTest(unittest.TestCase):
    def setUp(self):
        fd, self.db_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.client = create_app(self.db_path, tempfile.mkdtemp()).test_client()
        conn = db.connect(self.db_path)
        for name, col, row in [("Falcon", 5, 10), ("Kestrel", 10, 20), ("Pike", 15, 30)]:
            x, y = geometry.tnut_xy(col, row)
            conn.execute("INSERT INTO holds (name, x, y, tnut_col, tnut_row) VALUES (?, ?, ?, ?, ?)", (name, x, y, col, row))
        conn.commit()
        conn.close()
        self.alex = self.call("post", "/api/climbers", {"name": "Alex"})["id"]
        self.sam = self.call("post", "/api/climbers", {"name": "Sam"})["id"]
        self.slab = self.make_route("Slab", "easy", hold=1)
        self.crimp = self.make_route("Crimp", "medium", hold=2)
        self.roof = self.make_route("Roof", "hard", hold=3)

    def tearDown(self):
        os.remove(self.db_path)

    # helpers ---------------------------------------------------------------

    def call(self, method, url, data=None, status=None):
        res = getattr(self.client, method)(url, json=data)
        if status is not None:
            self.assertEqual(res.status_code, status, res.get_json())
        else:
            self.assertLess(res.status_code, 300, res.get_json())
        return res.get_json()

    def make_route(self, name, grade, hold, parent=None):
        return self.call("post", "/api/routes", {
            "name": name, "grade": grade, "set_date": "2026-09-01", "parent_id": parent,
            "holds": [{"hold_id": hold, "role": "start"}],
        })["id"]

    def create(self, name="Warm-up", route_ids=None, status=201, created_by=None):
        return self.call("post", "/api/circuits",
                         {"name": name, "route_ids": route_ids or [], "created_by": created_by}, status)

    def ids(self, circuit):
        return [r["id"] for r in circuit["routes"]]

    # tests -----------------------------------------------------------------

    def test_create_list_rename_delete(self):
        circuit = self.create("  Warm-up   laps ", [self.slab, self.crimp], created_by=self.alex)
        self.assertEqual(circuit["name"], "Warm-up laps")
        self.assertEqual(circuit["creator_name"], "Alex")
        self.assertEqual(self.ids(circuit), [self.slab, self.crimp])
        self.assertEqual((circuit["route_count"], circuit["grades"]), (2, ["easy", "medium"]))
        self.assertEqual(circuit["routes"][0]["holds"], [{"hold_id": 1, "role": "start"}])

        newer = self.create("Power")
        listed = self.call("get", "/api/circuits")
        self.assertEqual([c["id"] for c in listed], [newer["id"], circuit["id"]])   # newest first
        self.assertNotIn("routes", listed[0])

        renamed = self.call("put", "/api/circuits/%d" % circuit["id"], {"name": "Morning laps"})
        self.assertEqual((renamed["name"], self.ids(renamed)), ("Morning laps", [self.slab, self.crimp]))

        self.call("delete", "/api/circuits/%d" % circuit["id"])
        self.call("get", "/api/circuits/%d" % circuit["id"], status=404)
        self.call("delete", "/api/circuits/%d" % circuit["id"], status=404)
        # The climbs themselves are untouched.
        self.assertEqual(len(self.call("get", "/api/routes")), 3)

    def test_names(self):
        self.create("Warm-up")
        self.create("warm-UP", status=400)          # case-insensitive duplicate
        self.create("   ", status=400)
        self.create("x" * 81, status=400)
        other = self.create("Power")
        self.call("put", "/api/circuits/%d" % other["id"], {"name": "Warm-up"}, status=400)
        self.call("put", "/api/circuits/%d" % other["id"], {"name": "power"})   # own name, new case: fine

    def test_add_and_remove(self):
        circuit = self.create()
        url = "/api/circuits/%d/routes" % circuit["id"]
        self.call("post", url, {"route_id": self.roof}, status=201)
        after = self.call("post", url, {"route_id": self.slab}, status=201)
        self.assertEqual(self.ids(after), [self.roof, self.slab])          # appended in order
        self.call("post", url, {"route_id": self.slab}, status=400)        # already in it
        self.call("post", url, {"route_id": 999}, status=400)              # unknown climb
        self.call("post", url, {}, status=400)
        self.call("post", "/api/circuits/999/routes", {"route_id": self.slab}, status=404)

        after = self.call("delete", "%s/%d" % (url, self.roof))
        self.assertEqual(self.ids(after), [self.slab])
        self.call("delete", "%s/%d" % (url, self.roof), status=404)       # not a member any more
        after = self.call("post", url, {"route_id": self.roof}, status=201)
        self.assertEqual(self.ids(after), [self.slab, self.roof])

    def test_reorder_and_replace(self):
        circuit = self.create(route_ids=[self.slab, self.crimp, self.roof])
        url = "/api/circuits/%d" % circuit["id"]
        after = self.call("put", url, {"route_ids": [self.roof, self.slab, self.roof, self.crimp]})
        self.assertEqual(self.ids(after), [self.roof, self.slab, self.crimp])   # duplicates dropped
        self.assertEqual(self.ids(self.call("put", url, {"route_ids": [self.crimp]})), [self.crimp])
        self.call("put", url, {"route_ids": [self.crimp, 999]}, status=400)
        self.call("put", url, {"route_ids": "nope"}, status=400)
        self.assertEqual(self.ids(self.call("get", url)), [self.crimp])         # failed writes changed nothing

    def test_variations_can_join(self):
        variation = self.make_route("Slab Sit", "medium", hold=2, parent=self.slab)
        circuit = self.create(route_ids=[variation])
        self.assertEqual(circuit["routes"][0]["display_name"], "Slab — Slab Sit")

    def test_progress_for_me(self):
        circuit = self.create(route_ids=[self.slab, self.crimp, self.roof])
        for route in (self.slab, self.slab, self.roof):
            self.call("post", "/api/sends", {"route_id": route, "climber_id": self.sam, "sent_date": "2026-10-01"})
        mine = self.call("get", "/api/circuits?me=%d" % self.sam)[0]
        self.assertEqual((mine["sent_count"], mine["possible_count"]), (2, 3))
        self.assertEqual(self.call("get", "/api/circuits?me=%d" % self.alex)[0]["sent_count"], 0)
        detail = self.call("get", "/api/circuits/%d?me=%d" % (circuit["id"], self.sam))
        self.assertEqual([r["sent_by_me"] for r in detail["routes"]], [True, False, True])

    def test_climbs_that_are_no_longer_possible(self):
        circuit = self.create(route_ids=[self.slab, self.crimp])
        self.call("delete", "/api/holds/2")                                   # Kestrel: Crimp's only hold
        detail = self.call("get", "/api/circuits/%d" % circuit["id"])
        self.assertEqual([r["possible"] for r in detail["routes"]], [True, False])
        self.assertEqual(detail["possible_count"], 1)
        # It stays put through a reorder, but can't be newly added anywhere.
        after = self.call("put", "/api/circuits/%d" % circuit["id"], {"route_ids": [self.crimp, self.slab]})
        self.assertEqual(self.ids(after), [self.crimp, self.slab])
        other = self.create("Other")
        self.call("post", "/api/circuits/%d/routes" % other["id"], {"route_id": self.crimp}, status=400)
        self.create("Third", route_ids=[self.crimp], status=400)

    def test_deleting_a_route_drops_it_from_circuits(self):
        variation = self.make_route("Slab Sit", "medium", hold=2, parent=self.slab)
        circuit = self.create(route_ids=[self.roof, variation, self.crimp])
        self.call("delete", "/api/routes/%d" % self.slab)                      # takes its variation with it
        self.assertEqual(self.ids(self.call("get", "/api/circuits/%d" % circuit["id"])), [self.roof, self.crimp])

    def test_route_lists_its_circuits(self):
        b = self.create("B circuit", [self.slab])
        a = self.create("a circuit", [self.slab, self.roof])
        route = self.call("get", "/api/routes/%d" % self.slab)
        self.assertEqual(route["circuits"], [{"id": a["id"], "name": "a circuit"}, {"id": b["id"], "name": "B circuit"}])
        self.assertEqual(self.call("get", "/api/routes/%d" % self.crimp)["circuits"], [])

    def test_unknown_creator(self):
        self.create(created_by=999, status=400)
        circuit = self.create()
        self.assertIsNone(circuit["creator_name"])


if __name__ == "__main__":
    unittest.main()
