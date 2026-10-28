import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import db  # noqa: E402
import geometry  # noqa: E402
from app import create_app  # noqa: E402


class GeometryTest(unittest.TestCase):
    def test_wall_dimensions(self):
        self.assertEqual(geometry.WIDTH, 120.0)
        self.assertEqual(geometry.HEIGHT, 118.75)

    def test_columns_are_lettered_right_to_left(self):
        self.assertEqual(geometry.col_label(0), "A")
        self.assertEqual(geometry.col_label(25), "Z")
        self.assertEqual(geometry.col_label(26), "AA")
        self.assertEqual(geometry.col_label(39), "AN")
        # A1 is the top-right hole, 1.5" from the right and 2.75" from the top.
        self.assertEqual(geometry.tnut_xy(0, 0), (118.5, 2.75))
        # AN39 is the bottom-left hole, 1.5" from the left and 2" from the bottom.
        x, y = geometry.tnut_xy(39, 38)
        self.assertEqual(x, 1.5)
        self.assertEqual(geometry.HEIGHT - y, 2.0)


class ApiTest(unittest.TestCase):
    def setUp(self):
        fd, self.db_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.app = create_app(self.db_path)
        self.client = self.app.test_client()
        conn = db.connect(self.db_path)
        for col, row in [(0, 0), (5, 10), (10, 20), (15, 30)]:
            x, y = geometry.tnut_xy(col, row)
            conn.execute("INSERT INTO holds (x, y, tnut_col, tnut_row) VALUES (?, ?, ?, ?)", (x, y, col, row))
        conn.commit()
        conn.close()
        self.alex = self.post("/api/climbers", {"name": "Alex"})["id"]
        self.sam = self.post("/api/climbers", {"name": "Sam"})["id"]
        self.jo = self.post("/api/climbers", {"name": "Jo"})["id"]

    def tearDown(self):
        os.remove(self.db_path)

    # helpers ---------------------------------------------------------------

    def post(self, url, data, status=None):
        res = self.client.post(url, json=data)
        if status is not None:
            self.assertEqual(res.status_code, status, res.get_json())
        else:
            self.assertLess(res.status_code, 300, res.get_json())
        return res.get_json()

    def get(self, url):
        res = self.client.get(url)
        self.assertEqual(res.status_code, 200, res.get_json())
        return res.get_json()

    def make_route(self, name="Crimson Gecko", setter=None, parent=None, holds=None, grade="easy"):
        data = {
            "name": name,
            "grade": grade,
            "setter_id": setter or self.alex,
            "set_date": "2026-09-01",
            "holds": holds if holds is not None else [{"hold_id": 4, "role": "start"}, {"hold_id": 1, "role": "finish"}],
        }
        if parent:
            data["parent_id"] = parent
        return self.post("/api/routes", data)["id"]

    def send(self, route_id, climber, date, comment=""):
        return self.post("/api/sends", {"route_id": route_id, "climber_id": climber, "sent_date": date, "comment": comment})

    def route(self, route_id, me=None):
        return self.get("/api/routes/%d%s" % (route_id, "?me=%d" % me if me else ""))

    # first ascents -------------------------------------------------------

    def test_first_send_becomes_first_ascent(self):
        rid = self.make_route()
        self.assertTrue(self.send(rid, self.sam, "2026-09-05")["is_fa"])
        self.assertFalse(self.send(rid, self.alex, "2026-09-06")["is_fa"])
        r = self.route(rid)
        self.assertEqual((r["fa_name"], r["fa_date"]), ("Sam", "2026-09-05"))

    def test_backdated_send_takes_over_first_ascent(self):
        rid = self.make_route()
        self.send(rid, self.sam, "2026-09-05")
        self.assertTrue(self.send(rid, self.alex, "2026-09-03")["is_fa"])
        self.assertEqual(self.route(rid)["fa_name"], "Alex")

    def test_deleting_fa_send_recomputes(self):
        rid = self.make_route()
        first = self.send(rid, self.sam, "2026-09-05")["id"]
        self.send(rid, self.alex, "2026-09-07")
        self.client.delete("/api/sends/%d" % first)
        r = self.route(rid)
        self.assertEqual((r["fa_name"], r["fa_date"]), ("Alex", "2026-09-07"))
        self.client.delete("/api/sends/%d" % self.get("/api/climbers/%d/sends" % self.alex)["sends"][0]["id"])
        self.assertIsNone(self.route(rid)["fa_name"])

    def test_editing_fa_send_date_recomputes(self):
        rid = self.make_route()
        first = self.send(rid, self.sam, "2026-09-05")["id"]
        self.send(rid, self.alex, "2026-09-07")
        self.client.put("/api/sends/%d" % first, json={"sent_date": "2026-09-10"})
        self.assertEqual(self.route(rid)["fa_name"], "Alex")

    def test_fa_can_be_edited_manually(self):
        rid = self.make_route()
        self.send(rid, self.sam, "2026-09-05")
        res = self.client.put("/api/routes/%d" % rid, json={"fa_climber_id": self.jo, "fa_date": "2026-09-02"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(self.route(rid)["fa_name"], "Jo")
        res = self.client.put("/api/routes/%d" % rid, json={"fa_climber_id": self.jo, "fa_date": ""})
        self.assertEqual(res.status_code, 400)

    # repeats & ascents -----------------------------------------------------

    def test_logbook_flags_repeats_and_orders_by_date(self):
        rid = self.make_route()
        other = self.make_route("Quiet Riot")
        self.send(rid, self.sam, "2026-09-05", "flash")
        self.assertTrue(self.send(rid, self.sam, "2026-09-09", "again")["is_repeat"])
        self.send(other, self.sam, "2026-09-07")
        log = self.get("/api/climbers/%d/sends" % self.sam)
        self.assertEqual([s["sent_date"] for s in log["sends"]], ["2026-09-09", "2026-09-07", "2026-09-05"])
        self.assertEqual([s["is_repeat"] for s in log["sends"]], [True, False, False])
        self.assertEqual([s["is_fa"] for s in log["sends"]], [False, True, True])
        self.assertEqual(log["sends"][2]["comment"], "flash")
        self.assertEqual(log["summary"], {"total_sends": 3, "unique_climbs": 2, "first_ascents": 2})

    def test_ascents_list_has_one_row_per_climber(self):
        rid = self.make_route()
        self.send(rid, self.sam, "2026-09-05")
        self.send(rid, self.sam, "2026-09-08")
        self.send(rid, self.alex, "2026-09-06")
        self.send(rid, self.sam, "2026-09-10")
        ascents = self.route(rid)["ascents"]
        self.assertEqual([(a["name"], a["first_sent"], a["is_fa"]) for a in ascents],
                         [("Sam", "2026-09-05", True), ("Alex", "2026-09-06", False)])

    # search & filters ------------------------------------------------------

    def ids(self, query):
        result = self.get("/api/routes" + query)
        return sorted([r["id"] for r in result if r["matched"]] + [v["id"] for r in result for v in r["variations"]])

    def test_variations_found_by_base_name(self):
        base = self.make_route("Crimson Gecko")
        var = self.make_route("Sit Start", parent=base, grade="medium")
        self.make_route("Quiet Riot")
        self.assertEqual(self.ids("?q=gecko&scope=name"), sorted([base, var]))
        listing = self.get("/api/routes")
        gecko = next(r for r in listing if r["id"] == base)
        self.assertEqual([v["display_name"] for v in gecko["variations"]], ["Crimson Gecko — Sit Start"])
        family = self.route(var)["family"]
        self.assertEqual([f["id"] for f in family], [base, var])

    def test_variation_of_variation_attaches_to_base(self):
        base = self.make_route()
        var = self.make_route("A", parent=base)
        nested = self.make_route("B", parent=var)
        self.assertEqual(self.route(nested)["parent_id"], base)

    def test_search_by_setter_and_first_ascensionist(self):
        a = self.make_route("One", setter=self.alex)
        b = self.make_route("Two", setter=self.sam)
        self.send(b, self.jo, "2026-09-05")
        self.assertEqual(self.ids("?q=sam&scope=setter"), [b])
        self.assertEqual(self.ids("?q=jo&scope=fa"), [b])
        self.assertEqual(self.ids("?q=alex&scope=fa"), [])
        self.assertEqual(self.ids("?q=alex"), [a])

    def test_hide_sent_and_hold_filter(self):
        base = self.make_route("Crimson Gecko")
        var = self.make_route("Sit Start", parent=base, holds=[{"hold_id": 3, "role": "start"}])
        other = self.make_route("Quiet Riot", holds=[{"hold_id": 2, "role": "hand"}])
        self.send(base, self.sam, "2026-09-05")
        self.assertEqual(self.ids("?hide_sent_by=%d" % self.sam), sorted([var, other]))
        # Base is hidden but still returned as the container for its matching variation.
        listing = self.get("/api/routes?hide_sent_by=%d" % self.sam)
        self.assertFalse(next(r for r in listing if r["id"] == base)["matched"])
        self.assertEqual(self.ids("?hold_id=2"), [other])
        self.assertEqual(self.ids("?hold_id=4"), [base])
        self.assertEqual(self.ids("?grade=medium,hard"), [])

    def test_sent_by_me_flag(self):
        rid = self.make_route()
        self.send(rid, self.sam, "2026-09-05")
        self.assertTrue(self.route(rid, me=self.sam)["sent_by_me"])
        self.assertFalse(self.route(rid, me=self.alex)["sent_by_me"])

    # sorting ---------------------------------------------------------------

    def order(self, query):
        return [r["name"] for r in self.get("/api/routes" + query)]

    def make_sorted_fixture(self):
        def route(name, grade, set_date):
            return self.post("/api/routes", {"name": name, "grade": grade, "set_date": set_date, "holds": []})["id"]
        easy = route("Easy One", "easy", "2026-09-03")
        hard = route("Hard One", "hard", "2026-09-01")
        proj = route("Project One", "project", "2026-09-02")
        med = route("Medium One", "medium", "2026-09-04")
        # Hard: 2 climbers, 4 sends. Easy: 3 climbers, 3 sends. Medium: 1 climber, 1 send. Project: unsent.
        for climber, date in [(self.sam, "2026-09-10"), (self.sam, "2026-09-11"), (self.sam, "2026-09-12"), (self.alex, "2026-09-13")]:
            self.send(hard, climber, date)
        for climber in (self.sam, self.alex, self.jo):
            self.send(easy, climber, "2026-09-05")
        self.send(med, self.jo, "2026-09-20")
        return easy, hard, proj, med

    def test_sort_by_set_date_and_grade(self):
        self.make_sorted_fixture()
        self.assertEqual(self.order(""), ["Medium One", "Easy One", "Project One", "Hard One"])
        self.assertEqual(self.order("?sort=set_date&dir=asc"), ["Hard One", "Project One", "Easy One", "Medium One"])
        self.assertEqual(self.order("?sort=grade&dir=asc"), ["Easy One", "Medium One", "Hard One", "Project One"])
        self.assertEqual(self.order("?sort=grade&dir=desc"), ["Project One", "Hard One", "Medium One", "Easy One"])

    def test_sort_by_fa_date_puts_unsent_last(self):
        self.make_sorted_fixture()
        self.assertEqual(self.order("?sort=fa_date&dir=desc"), ["Medium One", "Hard One", "Easy One", "Project One"])
        self.assertEqual(self.order("?sort=fa_date&dir=asc"), ["Easy One", "Hard One", "Medium One", "Project One"])

    def test_sort_by_ascents_with_and_without_repeats(self):
        self.make_sorted_fixture()
        # Unique climbers: Easy 3, Hard 2, Medium 1, Project 0.
        self.assertEqual(self.order("?sort=ascents&dir=desc"), ["Easy One", "Hard One", "Medium One", "Project One"])
        # Every send: Hard 4, Easy 3, Medium 1, Project 0.
        self.assertEqual(self.order("?sort=sends&dir=desc"), ["Hard One", "Easy One", "Medium One", "Project One"])
        self.assertEqual(self.order("?sort=sends&dir=asc"), ["Project One", "Medium One", "Easy One", "Hard One"])
        counts = {r["name"]: (r["ascent_count"], r["send_count"]) for r in self.get("/api/routes")}
        self.assertEqual(counts["Hard One"], (2, 4))

    def test_sort_orders_variations_within_family(self):
        base = self.make_route("Base", grade="medium")
        v_hard = self.make_route("Harder", parent=base, grade="project")
        v_easy = self.make_route("Easier", parent=base, grade="easy")
        family = next(r for r in self.get("/api/routes?sort=grade&dir=asc") if r["id"] == base)
        self.assertEqual([v["id"] for v in family["variations"]], [v_easy, v_hard])
        family = next(r for r in self.get("/api/routes?sort=grade&dir=desc") if r["id"] == base)
        self.assertEqual([v["id"] for v in family["variations"]], [v_hard, v_easy])

    def test_family_placed_by_matching_variation_when_base_filtered(self):
        base = self.make_route("Base", grade="easy")
        self.make_route("Variant", parent=base, grade="project")
        self.make_route("Lonely Hard", grade="hard")
        # Only the project variation matches; it places its family above the hard route.
        self.assertEqual(self.order("?grade=hard,project&sort=grade&dir=desc"), ["Base", "Lonely Hard"])
        self.assertEqual(self.order("?grade=hard,project&sort=grade&dir=asc"), ["Lonely Hard", "Base"])

    def test_bad_sort_rejected(self):
        self.assertEqual(self.client.get("/api/routes?sort=height").status_code, 400)

    # validation & editing --------------------------------------------------

    def test_route_validation(self):
        self.post("/api/routes", {"name": "", "grade": "easy", "set_date": "2026-09-01"}, status=400)
        self.post("/api/routes", {"name": "X", "grade": "v12", "set_date": "2026-09-01"}, status=400)
        self.post("/api/routes", {"name": "X", "grade": "easy", "set_date": "nope"}, status=400)
        self.post("/api/routes", {"name": "X", "grade": "easy", "set_date": "2026-09-01",
                                  "holds": [{"hold_id": 99, "role": "hand"}]}, status=400)
        self.post("/api/routes", {"name": "X", "grade": "easy", "set_date": "2026-09-01",
                                  "holds": [{"hold_id": 1, "role": "knee"}]}, status=400)

    def test_edit_every_field(self):
        rid = self.make_route()
        res = self.client.put("/api/routes/%d" % rid, json={
            "name": "Renamed", "grade": "project", "setter_id": self.sam, "set_date": "2026-10-01",
            "notes": "No matching", "holds": [{"hold_id": 2, "role": "foot"}],
        })
        self.assertEqual(res.status_code, 200)
        r = self.route(rid)
        self.assertEqual((r["name"], r["grade"], r["setter_name"], r["set_date"], r["notes"]),
                         ("Renamed", "project", "Sam", "2026-10-01", "No matching"))
        self.assertEqual(r["holds"], [{"hold_id": 2, "role": "foot"}])

    def test_delete_base_removes_variations_and_sends(self):
        base = self.make_route()
        var = self.make_route("Sit", parent=base)
        self.send(var, self.sam, "2026-09-05")
        self.client.delete("/api/routes/%d" % base)
        self.assertEqual(self.client.get("/api/routes/%d" % var).status_code, 404)
        self.assertEqual(self.get("/api/climbers/%d/sends" % self.sam)["sends"], [])

    def test_duplicate_climber_returns_existing(self):
        again = self.post("/api/climbers", {"name": "alex"})
        self.assertEqual(again["id"], self.alex)


if __name__ == "__main__":
    unittest.main()
