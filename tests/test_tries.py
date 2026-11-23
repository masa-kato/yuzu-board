import unittest

from support import ApiTestCase


class TriesTest(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.add_holds([("Falcon", 5, 10), ("Kestrel", 10, 20)])
        self.alex = self.call("post", "/api/climbers", {"name": "Alex"})["id"]
        self.slab = self.make_route("Slab", hold=1)
        self.roof = self.make_route("Roof", hold=2)

    def make_route(self, name, hold):
        return self.call("post", "/api/routes", {
            "name": name, "grade": "hard", "set_date": "2026-09-01", "holds": [{"hold_id": hold, "role": "start"}],
        })["id"]

    def tried(self, route, date, note="", climber=None, status=201):
        return self.call("post", "/api/tries", {
            "route_id": route, "climber_id": climber or self.alex, "tried_date": date, "note": note,
        }, status)

    def test_one_mark_a_day(self):
        first = self.tried(self.slab, "2026-10-01", "the heel hook works")
        again = self.tried(self.slab, "2026-10-01", "the toe hook works better")
        self.assertEqual(first["id"], again["id"])
        self.assertEqual(again["note"], "the toe hook works better")
        self.tried(self.slab, "2026-10-03")
        tries = self.call("get", "/api/climbers/%d/sends" % self.alex)["tries"]
        self.assertEqual([(t["tried_date"], t["display_name"]) for t in tries],
                         [("2026-10-03", "Slab"), ("2026-10-01", "Slab")])
        # Tries aren't sends.
        self.assertEqual(self.call("get", "/api/climbers/%d/sends" % self.alex)["summary"]["total_sends"], 0)

    def test_edit_and_delete(self):
        t = self.tried(self.slab, "2026-10-01")
        other = self.tried(self.slab, "2026-10-02")
        self.call("put", "/api/tries/%d" % t["id"], {"tried_date": "2026-10-02"}, 400)
        self.call("put", "/api/tries/%d" % t["id"], {"tried_date": "2026-09-30", "note": "  wet  "})
        tries = self.call("get", "/api/climbers/%d/sends" % self.alex)["tries"]
        self.assertEqual([(x["tried_date"], x["note"]) for x in tries], [("2026-10-02", ""), ("2026-09-30", "wet")])
        self.call("delete", "/api/tries/%d" % other["id"])
        self.call("delete", "/api/tries/%d" % other["id"], status=404)

    def test_needs_a_real_climb_climber_and_date(self):
        self.tried(9999, "2026-10-01", status=404)
        self.tried(self.slab, "2026-10-01", climber=9999, status=400)
        self.tried(self.slab, "not a date", status=400)
        self.call("post", "/api/tries", {"route_id": self.slab}, 400)

    def test_my_history_on_the_climb(self):
        self.tried(self.slab, "2026-10-01", "high feet")
        self.call("post", "/api/sends", {"route_id": self.slab, "climber_id": self.alex, "sent_date": "2026-10-05", "comment": "flashed the crux"})
        self.tried(self.roof, "2026-10-02", "not this one")
        history = self.call("get", "/api/routes/%d?me=%d" % (self.slab, self.alex))["my_history"]
        self.assertEqual([(x["kind"], x["date"], x["note"]) for x in history],
                         [("send", "2026-10-05", "flashed the crux"), ("try", "2026-10-01", "high feet")])
        self.assertEqual(self.call("get", "/api/routes/%d" % self.slab)["my_history"], [])

    def test_only_the_admin_marks_tries_as_the_admin(self):
        masa = self.make_admin(log_in=False)
        self.tried(self.slab, "2026-10-01", climber=masa, status=401)
        self.call("post", "/api/login", {"password": "hangboard"})
        t = self.tried(self.slab, "2026-10-01", climber=masa)
        self.call("post", "/api/logout")
        self.call("put", "/api/tries/%d" % t["id"], {"note": "x"}, 401)
        self.call("delete", "/api/tries/%d" % t["id"], status=401)

    def test_deleting_the_climb_deletes_its_tries(self):
        self.tried(self.slab, "2026-10-01")
        self.call("delete", "/api/routes/%d" % self.slab)
        self.assertEqual(self.call("get", "/api/climbers/%d/sends" % self.alex)["tries"], [])


if __name__ == "__main__":
    unittest.main()
