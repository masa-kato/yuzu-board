import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import auth  # noqa: E402
import db  # noqa: E402
from app import create_app  # noqa: E402


class WorkoutTest(unittest.TestCase):
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
        self.exercises = {e["name"]: e for e in self.call("get", "/api/exercises")}

    def tearDown(self):
        os.remove(self.db_path)

    def call(self, method, url, data=None, status=None, client=None):
        res = getattr(client or self.client, method)(url, json=data)
        if status is not None:
            self.assertEqual(res.status_code, status, res.get_json())
        else:
            self.assertLess(res.status_code, 300, res.get_json())
        return res.get_json()

    def variant(self, exercise, name):
        return next(v["id"] for v in self.exercises[exercise]["variants"] if v["name"] == name)

    def block(self, date, exercise, variant=None):
        """Adds the exercise to the day's workout; returns its block."""
        workout = self.call("post", "/api/workouts/%s/exercises" % date, {
            "exercise_id": self.exercises[exercise]["id"], "variant_id": variant and self.variant(exercise, variant),
        }, 201)
        return workout["blocks"][-1]

    def sets(self, block, *sets):
        """Fills the block's empty first set with the first of `sets` and adds the rest."""
        first, *rest = sets
        self.call("put", "/api/sets/%d" % block["sets"][0]["id"], first)
        for s in rest:
            self.call("post", "/api/workout-exercises/%d/sets" % block["id"], s, 201)

    def test_only_the_admin(self):
        other = self.app.test_client()
        for method, url in [("get", "/api/exercises"), ("get", "/api/workouts/2026-11-01"),
                            ("put", "/api/workouts/2026-11-01"), ("get", "/api/workouts")]:
            self.call(method, url, {}, 401, other)

    def test_starter_exercises(self):
        self.assertEqual([v["name"] for v in self.exercises["Bench press"]["variants"]], ["Barbell", "Dumbbell"])
        self.assertEqual(self.exercises["Max hang"]["kind"], "hang")
        self.assertEqual(self.exercises["Plank"]["variants"], [])

    def test_a_workout_day(self):
        empty = self.call("get", "/api/workouts/2026-11-01")
        self.assertEqual((empty["id"], empty["blocks"]), (None, []))
        bench = self.block("2026-11-01", "Bench press", "Barbell")
        self.assertEqual(len(bench["sets"]), 1)   # one empty set to fill in
        self.sets(bench, {"weight": 135, "reps": 8}, {"weight": 145, "reps": 6})
        self.call("post", "/api/workouts/2026-11-01/exercises", {
            "exercise_id": self.exercises["Bench press"]["id"], "variant_id": self.variant("Bench press", "Barbell")}, 400)
        workout = self.call("put", "/api/workouts/2026-11-01", {"tiredness": 4, "notes": "slept badly"})
        self.assertEqual((workout["tiredness"], workout["notes"]), (4, "slept badly"))
        self.call("put", "/api/workouts/2026-11-01", {"tiredness": 6}, 400)
        self.assertEqual([(s["weight"], s["reps"]) for s in workout["blocks"][0]["sets"]], [(135, 8), (145, 6)])
        listed = self.call("get", "/api/workouts?from=2026-11-01&to=2026-11-30")
        self.assertEqual(listed, [{"workout_date": "2026-11-01", "tiredness": 4, "exercises": 1}])
        days = self.call("get", "/api/climbers/%d/days" % self.masa)["days"]
        self.assertTrue(days["2026-11-01"]["workout"])

    def test_a_set_keeps_only_its_kinds_fields(self):
        hang = self.block("2026-11-01", "Max hang", "Half crimp")
        s = self.call("put", "/api/sets/%d" % hang["sets"][0]["id"], {"seconds": 10, "weight": -15, "edge_mm": 20, "reps": 3})
        self.assertEqual((s["seconds"], s["weight"], s["edge_mm"], s["reps"]), (10, -15, 20, None))
        bench = self.block("2026-11-01", "Bench press", "Barbell")
        self.call("put", "/api/sets/%d" % bench["sets"][0]["id"], {"weight": -10}, 400)
        self.call("put", "/api/sets/%d" % bench["sets"][0]["id"], {"reps": "lots"}, 400)
        cleared = self.call("put", "/api/sets/%d" % hang["sets"][0]["id"], {"weight": ""})
        self.assertIsNone(cleared["weight"])

    def test_last_time_and_the_30_day_max(self):
        old = self.block("2026-09-01", "Bench press", "Barbell")
        self.sets(old, {"weight": 200, "reps": 1})   # too long ago to count
        a = self.block("2026-10-20", "Bench press", "Barbell")
        self.sets(a, {"weight": 155, "reps": 3})
        b = self.block("2026-11-01", "Bench press", "Barbell")
        self.sets(b, {"weight": 135, "reps": 8}, {"weight": 145, "reps": 6})
        dumbbell = self.block("2026-11-03", "Bench press", "Dumbbell")   # another variant: apart
        self.sets(dumbbell, {"weight": 60, "reps": 10})
        today = self.block("2026-11-05", "Bench press", "Barbell")
        self.sets(today, {"weight": 300, "reps": 1})   # today's own sets don't count
        ref = self.call("get", "/api/workouts/2026-11-05")["blocks"][0]["reference"]
        self.assertEqual(ref["metric"], "weight")
        self.assertEqual(ref["last"]["date"], "2026-11-01")
        self.assertEqual([(s["weight"], s["reps"]) for s in ref["last"]["sets"]], [(135, 8), (145, 6)])
        self.assertEqual((ref["max30"]["value"], ref["max30"]["date"]), (155, "2026-10-20"))
        first = self.call("get", "/api/workouts/2026-09-01")["blocks"][0]["reference"]
        self.assertEqual((first["last"], first["max30"]), (None, None))
        # A day whose sets were left empty isn't "last time".
        self.block("2026-11-06", "Bench press", "Barbell")
        later = self.block("2026-11-07", "Bench press", "Barbell")
        self.assertEqual(later["reference"]["last"]["date"], "2026-11-05")

    def test_bodyweight_progress_is_reps_until_weight_is_added(self):
        pullup = self.block("2026-11-01", "Pull-up", "Overhand")
        self.sets(pullup, {"reps": 8}, {"reps": 10})
        series = self.call("get", "/api/exercises/%d/progress" % self.exercises["Pull-up"]["id"])["series"]
        self.assertEqual([(s["metric"], [p["value"] for p in s["points"]]) for s in series], [("reps", [10])])
        weighted = self.block("2026-11-03", "Pull-up", "Overhand")
        self.sets(weighted, {"reps": 5, "weight": 25})
        progress = self.call("get", "/api/exercises/%d/progress" % self.exercises["Pull-up"]["id"])
        # Unweighted sets count as +0 lb.
        self.assertEqual([(s["metric"], [(p["date"], p["value"]) for p in s["points"]]) for s in progress["series"]],
                         [("weight", [("2026-11-01", 0), ("2026-11-03", 25)])])
        self.assertEqual([h["workout_date"] for h in progress["history"]], ["2026-11-03", "2026-11-01"])

    def test_timed_and_hang_progress(self):
        plank = self.block("2026-11-01", "Plank")
        self.sets(plank, {"seconds": 60}, {"seconds": 90})
        hang = self.block("2026-11-01", "Max hang", "Half crimp")
        self.sets(hang, {"seconds": 10, "weight": 20, "edge_mm": 20}, {"seconds": 10, "weight": 30, "edge_mm": 18})
        plank_series = self.call("get", "/api/exercises/%d/progress" % self.exercises["Plank"]["id"])["series"]
        self.assertEqual([(s["variant_id"], s["metric"], s["points"][0]["value"]) for s in plank_series], [(None, "seconds", 90)])
        hang_series = self.call("get", "/api/exercises/%d/progress" % self.exercises["Max hang"]["id"])["series"]
        self.assertEqual([(s["variant_name"], s["metric"], s["points"][0]["value"], s["points"][0]["edge_mm"]) for s in hang_series],
                         [("Half crimp", "weight", 30, 18)])

    def test_empty_workouts_go(self):
        bench = self.block("2026-11-01", "Bench press", "Barbell")
        workout = self.call("delete", "/api/workout-exercises/%d" % bench["id"])
        self.assertIsNone(workout["id"])
        self.assertNotIn("2026-11-01", self.call("get", "/api/climbers/%d/days" % self.masa)["days"])
        self.call("put", "/api/workouts/2026-11-02", {"tiredness": 2})
        self.call("delete", "/api/workouts/2026-11-02")
        self.call("delete", "/api/workouts/2026-11-02", status=404)

    def test_exercise_library(self):
        created = self.call("post", "/api/exercises", {"name": " Front  lever ", "kind": "timed", "variants": ["Tuck", "Full"]}, 201)
        self.assertEqual((created["name"], [v["name"] for v in created["variants"]]), ("Front lever", ["Tuck", "Full"]))
        self.call("post", "/api/exercises", {"name": "front lever", "kind": "timed"}, 400)
        self.call("post", "/api/exercises", {"name": "Thing", "kind": "cardio"}, 400)
        with_variant = self.call("post", "/api/exercises/%d/variants" % created["id"], {"name": "Straddle"}, 201)
        self.call("post", "/api/exercises/%d/variants" % created["id"], {"name": "tuck"}, 400)
        straddle = next(v for v in with_variant["variants"] if v["name"] == "Straddle")
        self.call("put", "/api/variants/%d" % straddle["id"], {"name": "Half lay"})
        self.call("put", "/api/exercises/%d" % created["id"], {"kind": "hang"})
        # Once done, it stays, and so does how it's measured.
        self.exercises = {e["name"]: e for e in self.call("get", "/api/exercises")}
        self.block("2026-11-01", "Front lever", "Tuck")
        self.call("put", "/api/exercises/%d" % created["id"], {"kind": "timed"}, 400)
        self.call("delete", "/api/exercises/%d" % created["id"], status=400)
        self.call("delete", "/api/variants/%d" % self.variant("Front lever", "Tuck"), status=400)
        self.call("delete", "/api/variants/%d" % straddle["id"])
        listed = next(e for e in self.call("get", "/api/exercises") if e["id"] == created["id"])
        self.assertEqual((listed["times"], listed["last_date"]), (1, "2026-11-01"))
        unused = self.call("post", "/api/exercises", {"name": "Wrist curl", "kind": "weight"}, 201)
        self.call("delete", "/api/exercises/%d" % unused["id"])

    def test_variants_know_when_they_were_last_done(self):
        self.block("2026-11-01", "Bench press", "Barbell")
        self.block("2026-11-04", "Bench press", "Barbell")
        self.block("2026-11-03", "Bench press", "Dumbbell")
        bench = next(e for e in self.call("get", "/api/exercises") if e["name"] == "Bench press")
        self.assertEqual({v["name"]: (v["times"], v["last_date"]) for v in bench["variants"]},
                         {"Barbell": (2, "2026-11-04"), "Dumbbell": (1, "2026-11-03")})
        self.assertEqual(bench["last_date"], "2026-11-04")
        squat = next(e for e in self.call("get", "/api/exercises") if e["name"] == "Squat")
        self.assertEqual([v["last_date"] for v in squat["variants"]], [None, None])

    def test_a_variant_added_later_leaves_the_plain_exercise(self):
        self.block("2026-11-01", "Plank")
        plank = self.call("post", "/api/exercises/%d/variants" % self.exercises["Plank"]["id"], {"name": "Side plank"}, 201)
        self.assertEqual(plank["plain_last_date"], "2026-11-01")
        self.assertEqual([(v["name"], v["last_date"]) for v in plank["variants"]], [("Side plank", None)])
        squat = next(e for e in self.call("get", "/api/exercises") if e["name"] == "Squat")
        self.assertIsNone(squat["plain_last_date"])

    def test_a_variant_of_another_exercise(self):
        self.call("post", "/api/workouts/2026-11-01/exercises", {
            "exercise_id": self.exercises["Squat"]["id"], "variant_id": self.variant("Bench press", "Barbell")}, 400)


if __name__ == "__main__":
    unittest.main()
