import unittest

from support import ApiTestCase


class DraftApiTest(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.add_holds([("Falcon", 5, 10), ("Kestrel", 10, 20), ("Pike", 15, 30)])
        self.alex = self.call("post", "/api/climbers", {"name": "Alex"})["id"]
        self.sam = self.call("post", "/api/climbers", {"name": "Sam"})["id"]

    # helpers ---------------------------------------------------------------

    def draft(self, status=201, **data):
        body = {"name": "", "grade": "medium", "holds": [{"hold_id": 1, "role": "start"}, {"hold_id": 2, "role": "hand"}]}
        body.update(data)
        return self.call("post", "/api/drafts", body, status)

    def make_route(self, name, hold=1, parent=None, **extra):
        return self.call("post", "/api/routes", dict({
            "name": name, "grade": "easy", "set_date": "2026-09-01", "parent_id": parent,
            "holds": [{"hold_id": hold, "role": "start"}],
        }, **extra), 201)["id"]

    def route_ids(self, **query):
        url = "/api/routes?" + "&".join("%s=%s" % kv for kv in query.items())
        families = self.call("get", url)
        return {r["id"] for f in families for r in [f, *f["variations"]]}

    # tests -----------------------------------------------------------------

    def test_create_list_update_delete(self):
        draft = self.draft(saved_by=self.alex, notes="  no matching ")
        self.assertEqual((draft["name"], draft["set_date"], draft["notes"]), ("", None, "no matching"))
        self.assertEqual(draft["saved_by_name"], "Alex")
        self.assertEqual(draft["holds"], [{"hold_id": 1, "role": "start"}, {"hold_id": 2, "role": "hand"}])

        newer = self.draft(name="Second")
        self.assertEqual([d["id"] for d in self.call("get", "/api/drafts")][:2], [newer["id"], draft["id"]])

        updated = self.call("put", "/api/drafts/%d" % draft["id"], {
            "name": " Velvet ", "grade": "hard", "set_date": "2026-11-14", "setter_id": self.sam,
            "saved_by": self.sam, "holds": [{"hold_id": 3, "role": "finish"}],
        })
        self.assertEqual((updated["name"], updated["grade"], updated["set_date"]), ("Velvet", "hard", "2026-11-14"))
        self.assertEqual((updated["setter_name"], updated["saved_by_name"]), ("Sam", "Sam"))
        self.assertEqual(updated["holds"], [{"hold_id": 3, "role": "finish"}])
        self.assertEqual(updated["notes"], "")   # the form sends every field, so a dropped one clears

        self.call("delete", "/api/drafts/%d" % draft["id"])
        self.call("get", "/api/drafts/%d" % draft["id"], status=404)
        self.call("delete", "/api/drafts/%d" % draft["id"], status=404)
        self.assertEqual([d["id"] for d in self.call("get", "/api/drafts")], [newer["id"]])

    def test_drafts_stay_out_of_the_climb_lists(self):
        route = self.make_route("Slab")
        self.draft(name="Slab draft")
        self.assertEqual(self.route_ids(), {route})
        self.assertEqual(self.route_ids(legacy=1), set())

    def test_validation(self):
        self.draft(grade="v12", status=400)
        self.draft(set_date="tomorrow", status=400)
        self.draft(setter_id=999, status=400)
        self.draft(saved_by=999, status=400)
        self.draft(parent_id=999, status=404)
        self.draft(holds=[{"hold_id": 99, "role": "start"}], status=400)
        self.draft(holds=[{"hold_id": 1, "role": "crimp"}], status=400)
        self.assertEqual(self.call("get", "/api/drafts"), [])

    def test_removed_holds(self):
        draft = self.draft()
        self.call("delete", "/api/holds/2")   # removed from the wall
        # A new draft can't use it, but one that already had it may keep it.
        self.draft(holds=[{"hold_id": 2, "role": "hand"}], status=400)
        kept = self.call("put", "/api/drafts/%d" % draft["id"], {"grade": "easy", "holds": draft["holds"]})
        self.assertEqual(len(kept["holds"]), 2)
        # Deleting it for good drops it from the draft (no climb uses it).
        self.call("delete", "/api/holds/2/permanent")
        self.assertEqual(self.call("get", "/api/drafts/%d" % draft["id"])["holds"], [{"hold_id": 1, "role": "start"}])

    def test_variation_drafts(self):
        base = self.make_route("Slab")
        sit = self.make_route("Sit", parent=base)
        draft = self.draft(name="Stand", parent_id=sit)
        self.assertEqual((draft["parent_id"], draft["parent_name"]), (base, "Slab"))   # hangs off the base
        self.call("delete", "/api/routes/%d" % base)
        self.call("get", "/api/drafts/%d" % draft["id"], status=404)

    def test_publishing(self):
        draft = self.draft(name="Velvet")
        # A failed publish (no set date) leaves the draft.
        self.call("post", "/api/routes", {"name": "Velvet", "grade": "medium", "draft_id": draft["id"]}, 400)
        self.call("get", "/api/drafts/%d" % draft["id"])

        route = self.make_route("Velvet", draft_id=draft["id"])
        self.call("get", "/api/drafts/%d" % draft["id"], status=404)
        self.assertEqual(self.route_ids(), {route})
        # A draft that is already gone doesn't stop the climb.
        self.make_route("Again", draft_id=draft["id"])
        # and its id isn't handed to the next draft.
        self.assertGreater(self.draft()["id"], draft["id"])

    def to_draft(self, route_id, status=201, saved_by=None):
        return self.call("post", "/api/routes/%d/draft" % route_id, {"saved_by": saved_by}, status)

    def test_climb_back_to_draft(self):
        route = self.make_route("Velvet", setter_id=self.sam, notes="no matching",
                                holds=[{"hold_id": 1, "role": "start"}, {"hold_id": 2, "role": "finish"}])
        circuit = self.call("post", "/api/circuits", {"name": "Warm-up", "route_ids": [route]})
        self.call("delete", "/api/holds/2")   # removed since: the draft keeps it all the same
        self.to_draft(route, saved_by=999, status=400)
        self.call("get", "/api/routes/%d" % route)   # still a climb
        draft = self.to_draft(route, saved_by=self.alex)
        self.assertEqual((draft["name"], draft["grade"], draft["set_date"], draft["notes"]),
                         ("Velvet", "easy", "2026-09-01", "no matching"))
        self.assertEqual((draft["setter_name"], draft["saved_by_name"], draft["parent_id"]), ("Sam", "Alex", None))
        self.assertEqual(draft["holds"], [{"hold_id": 1, "role": "start"}, {"hold_id": 2, "role": "finish"}])
        # The climb is gone, and out of its circuit.
        self.call("get", "/api/routes/%d" % route, status=404)
        self.assertEqual(self.route_ids() | self.route_ids(legacy=1), set())
        self.assertEqual(self.call("get", "/api/circuits/%d" % circuit["id"])["routes"], [])

    def test_variation_back_to_draft(self):
        base = self.make_route("Slab")
        sit = self.make_route("Sit", parent=base)
        draft = self.to_draft(sit)
        self.assertEqual((draft["parent_id"], draft["parent_name"], draft["saved_by_name"]), (base, "Slab", None))
        self.assertEqual(self.route_ids(), {base})

    def test_climbs_that_stay(self):
        sent = self.make_route("Sent")
        self.call("post", "/api/sends", {"route_id": sent, "climber_id": self.alex, "sent_date": "2026-10-01"})
        self.to_draft(sent, status=400)

        fa = self.make_route("Claimed", fa_climber_id=self.alex, fa_date="2026-10-01")
        self.to_draft(fa, status=400)

        base = self.make_route("Slab")
        sit = self.make_route("Sit", parent=base)
        res = self.to_draft(base, status=400)
        self.assertIn("Sit", res["error"])
        self.call("delete", "/api/routes/%d" % sit)
        self.draft(parent_id=base)   # a draft variation hangs off it too
        self.to_draft(base, status=400)

        self.to_draft(999, status=404)
        self.assertEqual(self.route_ids(), {sent, fa, base})
        self.assertEqual(len(self.call("get", "/api/drafts")), 1)


if __name__ == "__main__":
    unittest.main()
