import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import auth  # noqa: E402
import db  # noqa: E402
from app import create_app  # noqa: E402

HEALTHY = [0] * 10


def sore(**fingers):
    """Scores with some fingers sore: sore(left_middle=4)."""
    names = ["left_thumb", "left_index", "left_middle", "left_ring", "left_pinky",
             "right_thumb", "right_index", "right_middle", "right_ring", "right_pinky"]
    return [fingers.get(name, 0) for name in names]


class FingerTest(unittest.TestCase):
    def setUp(self):
        fd, self.db_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.app = create_app(self.db_path, tempfile.mkdtemp())
        self.client = self.app.test_client()
        auth.PASSWORD_METHOD = "pbkdf2:sha256:1000"
        conn = db.connect(self.db_path)
        self.masa = auth.set_admin(conn, "Masa", "hangboard")
        conn.close()
        self.call("post", "/api/login", {"password": "hangboard"})

    def tearDown(self):
        os.remove(self.db_path)

    def call(self, method, url, data=None, status=None, client=None):
        res = getattr(client or self.client, method)(url, json=data)
        if status is not None:
            self.assertEqual(res.status_code, status, res.get_json())
        else:
            self.assertLess(res.status_code, 300, res.get_json())
        return res.get_json()

    def save(self, date, phase, scores, comment="", status=None):
        return self.call("put", "/api/fingers/%s/%s" % (date, phase), {"scores": scores, "comment": comment}, status)

    def test_only_the_admin(self):
        other = self.app.test_client()
        self.call("get", "/api/fingers/2026-11-01", None, 401, other)
        self.call("put", "/api/fingers/2026-11-01/end", {"scores": HEALTHY}, 401, other)
        self.call("delete", "/api/fingers/2026-11-01/end", None, 401, other)

    def test_start_and_end_of_a_session(self):
        self.assertEqual(self.call("get", "/api/fingers/2026-11-01"), {"start": None, "end": None, "previous": None})
        day = self.save("2026-11-01", "start", sore(left_middle=4), "  a bit stiff  ")
        self.assertEqual((day["start"]["scores"], day["start"]["comment"], day["end"]), (sore(left_middle=4), "a bit stiff", None))
        day = self.save("2026-11-01", "end", sore(left_middle=6, right_ring=2), "tweaky on crimps")
        self.assertEqual(day["end"]["scores"], sore(left_middle=6, right_ring=2))
        self.assertEqual(day["start"]["scores"], sore(left_middle=4))
        # Saving a phase again replaces it.
        day = self.save("2026-11-01", "end", sore(left_middle=5))
        self.assertEqual((day["end"]["scores"], day["end"]["comment"]), (sore(left_middle=5), ""))
        # 0 (healthy) and 10 are both scores.
        day = self.save("2026-11-01", "end", sore(left_middle=10, right_ring=1))
        self.assertEqual(day["end"]["scores"], [0, 0, 10, 0, 0, 0, 0, 0, 1, 0])

    def test_end_on_its_own_on_a_rest_day(self):
        day = self.save("2026-11-02", "end", sore(right_index=3), "rest day, feels better")
        self.assertIsNone(day["start"])
        self.assertEqual(day["end"]["comment"], "rest day, feels better")

    def test_bad_checks(self):
        self.save("2026-11-01", "middle", HEALTHY, status=404)
        self.save("not-a-date", "end", HEALTHY, status=400)
        self.save("2026-11-01", "end", [0] * 9, status=400)
        self.save("2026-11-01", "end", [-1] + [0] * 9, status=400)
        self.save("2026-11-01", "end", [11] + [0] * 9, status=400)
        self.save("2026-11-01", "end", ["3"] + [0] * 9, status=400)
        self.save("2026-11-01", "end", [False] + [0] * 9, status=400)
        self.call("put", "/api/fingers/2026-11-01/end", {}, 400)
        self.save("2026-11-01", "end", HEALTHY, "x" * 2001, status=400)
        self.assertEqual(self.call("get", "/api/fingers/2026-11-01"), {"start": None, "end": None, "previous": None})

    def test_the_last_check_before_the_day(self):
        self.save("2026-11-03", "start", sore(left_middle=4), "stiff")
        self.save("2026-11-03", "end", sore(left_middle=6), "tweaky on crimps")
        self.save("2026-11-05", "start", sore(left_middle=2))
        self.save("2026-11-08", "end", HEALTHY)
        # The day's end over its start, from the latest earlier day.
        previous = self.call("get", "/api/fingers/2026-11-04")["previous"]
        self.assertEqual((previous["date"], previous["phase"], previous["scores"], previous["comment"]),
                         ("2026-11-03", "end", sore(left_middle=6), "tweaky on crimps"))
        # A start on its own counts, and the day itself doesn't.
        day = self.call("get", "/api/fingers/2026-11-08")
        self.assertEqual((day["previous"]["date"], day["previous"]["phase"]), ("2026-11-05", "start"))
        self.assertEqual(day["end"]["scores"], HEALTHY)
        self.assertEqual(self.call("get", "/api/fingers/2026-11-20")["previous"]["date"], "2026-11-08")
        self.assertIsNone(self.call("get", "/api/fingers/2026-11-03")["previous"])

    def test_every_check_newest_first(self):
        self.save("2026-11-03", "start", sore(left_middle=4), "stiff")
        self.save("2026-11-03", "end", sore(left_middle=6))
        self.save("2026-11-08", "end", HEALTHY)
        checks = self.call("get", "/api/fingers")["checks"]
        self.assertEqual([(c["date"], c["phase"]) for c in checks],
                         [("2026-11-08", "end"), ("2026-11-03", "end"), ("2026-11-03", "start")])
        self.assertEqual((checks[2]["scores"], checks[2]["comment"]), (sore(left_middle=4), "stiff"))
        self.call("get", "/api/fingers", None, 401, self.app.test_client())

    def test_delete(self):
        self.save("2026-11-01", "start", HEALTHY)
        self.save("2026-11-01", "end", HEALTHY)
        day = self.call("delete", "/api/fingers/2026-11-01/start")
        self.assertIsNone(day["start"])
        self.assertIsNotNone(day["end"])
        self.call("delete", "/api/fingers/2026-11-01/start", status=404)

    def test_calendar_days(self):
        self.save("2026-11-01", "end", sore(left_middle=6), "tweaky")
        alex = self.call("post", "/api/climbers", {"name": "Alex"})["id"]
        days = self.call("get", "/api/climbers/%d/days" % self.masa)["days"]
        # A rest day with only a check is on the calendar, with nothing climbed.
        self.assertEqual(days["2026-11-01"]["sends"], 0)
        self.assertEqual(days["2026-11-01"]["fingers"]["end"]["scores"], sore(left_middle=6))
        self.assertIsNone(days["2026-11-01"]["fingers"]["start"])
        # Nobody else's days, and not the admin's while logged out.
        self.assertEqual(self.call("get", "/api/climbers/%d/days" % alex)["days"], {})
        self.call("post", "/api/logout")
        self.assertEqual(self.call("get", "/api/climbers/%d/days" % self.masa)["days"], {})


class HealthyIsZeroMigrationTest(unittest.TestCase):
    """Scores from before healthy was 0 have their 1s made 0, once: a 1 saved
    afterwards stays a 1."""

    def test_ones_become_zeros_once(self):
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.addCleanup(os.remove, path)
        conn = db.connect(path)
        with open(db.SCHEMA_PATH) as f:
            conn.executescript(f.read())
        conn.execute("INSERT INTO finger_checks (check_date, phase, scores) VALUES ('2026-11-01', 'end', ?)",
                     ("[1, 1, 4, 1, 1, 1, 1, 1, 2, 1]",))
        conn.commit()
        conn.close()
        create_app(path, tempfile.mkdtemp())
        conn = db.connect(path)
        self.assertEqual(conn.execute("SELECT scores FROM finger_checks").fetchone()[0], "[0, 0, 4, 0, 0, 0, 0, 0, 2, 0]")
        conn.execute("UPDATE finger_checks SET scores = '[1, 0, 4, 0, 0, 0, 0, 0, 2, 0]'")
        conn.commit()
        conn.close()
        create_app(path, tempfile.mkdtemp())
        conn = db.connect(path)
        self.assertEqual(conn.execute("SELECT scores FROM finger_checks").fetchone()[0], "[1, 0, 4, 0, 0, 0, 0, 0, 2, 0]")
        conn.close()


if __name__ == "__main__":
    unittest.main()
