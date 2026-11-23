import unittest

from support import ApiTestCase, ScratchTestCase

import db
from app import create_app


class OutdoorTest(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.masa = self.make_admin()

    def session(self, date, entries, area="Bishop", notes="", status=201):
        return self.call("post", "/api/outdoor/sessions",
                         {"session_date": date, "area": area, "notes": notes, "entries": entries}, status)

    def test_only_the_admin(self):
        other = self.app.test_client()
        for method, url in [("get", "/api/outdoor/sessions"), ("post", "/api/outdoor/sessions"),
                            ("get", "/api/outdoor/climbs"), ("post", "/api/outdoor/climbs")]:
            self.call(method, url, {}, 401, other)

    def test_a_session_adds_new_climbs_and_reuses_known_ones(self):
        s = self.session("2026-11-01", [
            {"climb": {"name": "Saigon", "area": "Buttermilks", "grade": "V9"}, "sent": False, "note": "left hand gaston"},
            {"climb": {"name": "  Iron   Man ", "area": "Buttermilks", "grade": "V4"}, "sent": True},
        ], notes="cold, good friction")
        self.assertEqual([(e["name"], e["sent"], e["note"]) for e in s["entries"]],
                         [("Saigon", False, "left hand gaston"), ("Iron Man", True, "")])
        saigon = s["entries"][0]["climb_id"]
        # A new climb with a known name in that area is the same climb.
        again = self.session("2026-11-08", [{"climb": {"name": "saigon", "area": "buttermilks"}, "note": "stick the crimp"}])
        self.assertEqual(again["entries"][0]["climb_id"], saigon)
        self.assertEqual(len(self.call("get", "/api/outdoor/climbs")), 2)
        # The same name elsewhere is another climb.
        elsewhere = self.session("2026-11-09", [{"climb": {"name": "Saigon", "area": "Happies"}}])
        self.assertNotEqual(elsewhere["entries"][0]["climb_id"], saigon)

    def test_a_climbs_notes_from_every_session(self):
        first = self.session("2026-11-01", [{"climb": {"name": "Saigon", "area": "Buttermilks"}, "note": "gaston"}])
        saigon = first["entries"][0]["climb_id"]
        self.session("2026-11-08", [{"climb_id": saigon, "sent": True, "note": "sent it!"}])
        climb = self.call("get", "/api/outdoor/climbs/%d" % saigon)
        self.assertEqual([(h["session_date"], h["sent"], h["note"]) for h in climb["history"]],
                         [("2026-11-08", True, "sent it!"), ("2026-11-01", False, "gaston")])
        self.assertEqual((climb["session_count"], climb["first_sent"], climb["sent"]), (2, "2026-11-08", True))

    def test_session_numbers(self):
        # Hagakure had 4 sessions before any were logged, so the first logged is its 5th.
        first = self.session("2026-11-17", [{"climb": {"name": "Hagakure", "area": "Index", "grade": "V12"}}], area="Index")
        hagakure = first["entries"][0]["climb_id"]
        self.assertEqual(first["entries"][0]["session_number"], 1)
        climb = self.call("put", "/api/outdoor/climbs/%d" % hagakure, {"prior_sessions": 4})
        self.assertEqual((climb["prior_sessions"], climb["session_count"], climb["total_sessions"]), (4, 1, 5))
        self.assertEqual(self.call("get", "/api/outdoor/sessions/%d" % first["id"])["entries"][0]["session_number"], 5)
        # Numbered by date, not by when they were logged: a session logged later for an earlier day comes first.
        later = self.session("2026-11-24", [{"climb_id": hagakure, "sent": True}], area="Index")
        earlier = self.session("2026-11-10", [{"climb_id": hagakure}], area="Index")
        numbers = {s["session_date"]: s["entries"][0]["session_number"] for s in self.call("get", "/api/outdoor/sessions")}
        self.assertEqual(numbers, {"2026-11-10": 5, "2026-11-17": 6, "2026-11-24": 7})
        self.assertEqual([(x["session_date"], x["session_number"]) for x in self.call("get", "/api/outdoor/climbs/%d" % hagakure)["history"]],
                         [("2026-11-24", 7), ("2026-11-17", 6), ("2026-11-10", 5)])
        # A Hagakure elsewhere is another climb, counted on its own.
        elsewhere = self.session("2026-11-24", [{"climb": {"name": "Hagakure", "area": "Squamish"}}], area="Squamish")
        self.assertNotEqual(elsewhere["entries"][0]["climb_id"], hagakure)
        self.assertEqual(elsewhere["entries"][0]["session_number"], 1)
        # Deleting a session renumbers the ones after it.
        self.call("delete", "/api/outdoor/sessions/%d" % earlier["id"])
        self.assertEqual(self.call("get", "/api/outdoor/sessions/%d" % later["id"])["entries"][0]["session_number"], 6)

    def test_day_notes_and_the_session_it_was_sent_on(self):
        first = self.session("2026-11-10", [{"climb": {"name": "Hagakure", "area": "Index"}, "note": "crimp"}],
                             area="Index", notes="Humid, greasy holds.")
        hagakure = first["entries"][0]["climb_id"]
        self.call("put", "/api/outdoor/climbs/%d" % hagakure, {"prior_sessions": 4})
        self.assertIsNone(self.call("get", "/api/outdoor/climbs/%d" % hagakure)["sent_session"])
        self.session("2026-11-24", [{"climb_id": hagakure, "sent": True}], area="Index")
        self.session("2026-11-30", [{"climb_id": hagakure, "sent": True}], area="Index")   # a repeat
        climb = self.call("get", "/api/outdoor/climbs/%d" % hagakure)
        self.assertEqual((climb["first_sent"], climb["sent_session"]), ("2026-11-24", 6))
        self.assertEqual([(x["session_number"], x["session_notes"]) for x in climb["history"]],
                         [(7, ""), (6, ""), (5, "Humid, greasy holds.")])
        # A Hagakure elsewhere, sent on its first session, has its own count.
        self.session("2026-11-24", [{"climb": {"name": "Hagakure", "area": "Squamish"}, "sent": True}], area="Squamish")
        sent_on = {(c["name"], c["area"]): c["sent_session"] for c in self.call("get", "/api/outdoor/climbs")}
        self.assertEqual(sent_on, {("Hagakure", "Index"): 6, ("Hagakure", "Squamish"): 1})

    def test_bad_prior_sessions(self):
        climb = self.call("post", "/api/outdoor/climbs", {"name": "Saigon", "prior_sessions": 2}, 201)
        self.assertEqual(climb["total_sessions"], 2)
        for bad in (-1, 1000, "lots", "2.5"):
            self.call("put", "/api/outdoor/climbs/%d" % climb["id"], {"prior_sessions": bad}, 400)
        # Left out, it stays; blank is none.
        self.assertEqual(self.call("put", "/api/outdoor/climbs/%d" % climb["id"], {"grade": "V9"})["prior_sessions"], 2)
        self.assertEqual(self.call("put", "/api/outdoor/climbs/%d" % climb["id"], {"prior_sessions": ""})["prior_sessions"], 0)

    def test_edit_a_session(self):
        s = self.session("2026-11-01", [{"climb": {"name": "Saigon"}}, {"climb": {"name": "Iron Man"}}])
        saigon, iron = (e["climb_id"] for e in s["entries"])
        edited = self.call("put", "/api/outdoor/sessions/%d" % s["id"], {
            "session_date": "2026-11-02", "entries": [{"climb_id": iron, "sent": True}],
        })
        self.assertEqual(edited["session_date"], "2026-11-02")
        self.assertEqual(edited["area"], "Bishop")
        self.assertEqual([e["climb_id"] for e in edited["entries"]], [iron])
        # Saigon stays a climb, with no sessions now.
        self.assertEqual(self.call("get", "/api/outdoor/climbs/%d" % saigon)["history"], [])

    def test_bad_sessions(self):
        self.session("not a date", [], status=400)
        self.session("2026-11-01", [{"climb_id": 999}], status=400)
        self.session("2026-11-01", [{"climb": {"name": ""}}], status=400)
        self.session("2026-11-01", [{}], status=400)
        self.session("2026-11-01", [{"climb": {"name": "A"}}, {"climb": {"name": "a"}}], status=400)
        # Nothing half-saved from the failed ones.
        self.assertEqual(self.call("get", "/api/outdoor/sessions"), [])
        self.assertEqual(self.call("get", "/api/outdoor/climbs"), [])

    def test_climbs_and_calendar_days(self):
        climb = self.call("post", "/api/outdoor/climbs", {"name": "Saigon", "area": "Buttermilks", "grade": "V9"}, 201)
        self.call("post", "/api/outdoor/climbs", {"name": "saigon", "area": "Buttermilks"}, 400)
        renamed = self.call("put", "/api/outdoor/climbs/%d" % climb["id"], {"grade": "V8"})
        self.assertEqual((renamed["name"], renamed["grade"]), ("Saigon", "V8"))
        s = self.session("2026-11-01", [{"climb_id": climb["id"]}])
        days = self.call("get", "/api/climbers/%d/days" % self.masa)["days"]
        self.assertEqual(days["2026-11-01"]["outdoor"], 1)
        # Logged out, the admin's days are climbing on the wall only.
        self.call("post", "/api/logout")
        self.assertEqual(self.call("get", "/api/climbers/%d/days" % self.masa)["days"], {})
        self.call("post", "/api/login", {"password": "hangboard"})
        self.call("delete", "/api/outdoor/climbs/%d" % climb["id"])
        self.assertEqual(self.call("get", "/api/outdoor/sessions/%d" % s["id"])["entries"], [])
        self.call("delete", "/api/outdoor/sessions/%d" % s["id"])
        self.call("get", "/api/outdoor/sessions/%d" % s["id"], status=404)


if __name__ == "__main__":
    unittest.main()


class PriorSessionsMigrationTest(ScratchTestCase):
    """A database from before sessions were counted gains
    outdoor_climbs.prior_sessions, 0 for the climbs it already has."""

    def test_old_database_gains_the_column(self):
        path = self.scratch("test.db")
        conn = db.connect(path)
        with open(db.SCHEMA_PATH) as f:
            conn.executescript(f.read().replace(
                "    prior_sessions  INTEGER NOT NULL DEFAULT 0 CHECK (prior_sessions >= 0),\n", ""))
        conn.execute("INSERT INTO outdoor_climbs (name, area) VALUES ('Hagakure', 'Index')")
        conn.commit()
        self.assertNotIn("prior_sessions", [r["name"] for r in conn.execute("PRAGMA table_info(outdoor_climbs)")])
        conn.close()
        create_app(path, self.scratch("uploads"))
        conn = db.connect(path)
        self.assertEqual(conn.execute("SELECT name, prior_sessions FROM outdoor_climbs").fetchone()[:], ("Hagakure", 0))
        conn.close()
