"""The admin's workouts (schema.sql: exercises, exercise_variants, workouts,
workout_exercises, workout_sets). One workout a day, keyed by its date; each
exercise done is a block of sets. Each block comes with what was done last
time and the best of the last 30 days, and each exercise's progress is a
series per variant. Only the admin, logged in, sees any of it (auth.py).

Progress is measured per variant, the same way across its whole history
(`metric`): its heaviest set once any set has a weight (an unweighted set
counting as +0 lb), otherwise its most reps (bodyweight) or longest hold
(timed, hang). Weights are in pounds."""

import datetime

from flask import Blueprint, jsonify, request

import db
from auth import admin_required
from helpers import bad_request, not_found, optional_int, parse_date, parse_float, text

bp = Blueprint("workouts", __name__)

KINDS = ("weight", "bodyweight", "timed", "hang")
# The set columns each kind of exercise fills; the others stay null.
KIND_FIELDS = {
    "weight": ("weight", "reps"),
    "bodyweight": ("reps", "weight"),
    "timed": ("seconds", "weight"),
    "hang": ("seconds", "weight", "edge_mm"),
}
# What a set needs before it counts as done, for each kind.
KIND_MAIN = {"weight": "weight", "bodyweight": "reps", "timed": "seconds", "hang": "seconds"}
RECENT_DAYS = 30
NAME_MAX = 80
NOTE_MAX = 4000
MAX_VARIANTS = 30
WEIGHT_MIN, WEIGHT_MAX = -1000, 2000   # negative: assistance
REPS_MAX = 1000
SECONDS_MAX = 3 * 3600
EDGE_MIN, EDGE_MAX = 1, 100   # mm
SET_FIELDS = ("reps", "weight", "seconds", "edge_mm")


def get_exercise_or_404(conn, exercise_id):
    exercise = db.row(conn.execute("SELECT * FROM exercises WHERE id = ?", (exercise_id,)))
    if exercise is None:
        not_found("Exercise not found")
    return exercise


def get_variant_or_404(conn, variant_id):
    variant = db.row(conn.execute("SELECT * FROM exercise_variants WHERE id = ?", (variant_id,)))
    if variant is None:
        not_found("Variant not found")
    return variant


def get_block_or_404(conn, block_id):
    block = db.row(conn.execute(
        """SELECT we.*, e.kind, w.workout_date FROM workout_exercises we
           JOIN exercises e ON e.id = we.exercise_id JOIN workouts w ON w.id = we.workout_id
           WHERE we.id = ?""", (block_id,)))
    if block is None:
        not_found("That exercise isn't in the workout")
    return block


def get_set_or_404(conn, set_id):
    s = db.row(conn.execute(
        """SELECT ws.*, e.kind FROM workout_sets ws
           JOIN workout_exercises we ON we.id = ws.workout_exercise_id JOIN exercises e ON e.id = we.exercise_id
           WHERE ws.id = ?""", (set_id,)))
    if s is None:
        not_found("Set not found")
    return s


def clean_name(data, key, field):
    name = " ".join(text(data, key, field, NAME_MAX).split())
    if not name:
        bad_request("%s is required" % field)
    return name


def plain_set(s):
    return {k: s[k] for k in ("id", "position") + SET_FIELDS}


# ---- progress ---------------------------------------------------------------


def metric(kind, sets):
    """What one variant's progress is measured in, given all its sets."""
    if kind == "weight" or any(s["weight"] is not None for s in sets):
        return "weight"
    return "reps" if kind == "bodyweight" else "seconds"


def set_value(kind, measure, s):
    """A set's value in `measure`, or None if it doesn't count (not filled in)."""
    if s[KIND_MAIN[kind]] is None:
        return None
    if measure == "weight":
        return s["weight"] if s["weight"] is not None else 0.0
    return s[measure]


def variant_sets(conn, exercise_id, variant_id):
    """Every set of an exercise's variant (None: done without one), oldest first."""
    return db.rows(conn.execute(
        """SELECT ws.*, w.workout_date FROM workout_sets ws
           JOIN workout_exercises we ON we.id = ws.workout_exercise_id
           JOIN workouts w ON w.id = we.workout_id
           WHERE we.exercise_id = ? AND we.variant_id IS ?
           ORDER BY w.workout_date, we.position, ws.position, ws.id""",
        (exercise_id, variant_id),
    ))


def best(kind, measure, sets):
    """{value, date, edge_mm} of the best set among `sets`, or None."""
    top = None
    for s in sets:
        value = set_value(kind, measure, s)
        if value is not None and (top is None or value > top["value"]):
            top = {"value": value, "date": s["workout_date"], "edge_mm": s["edge_mm"]}
    return top


def reference(conn, kind, exercise_id, variant_id, date):
    """For a block on `date`: the sets of the last earlier day with this
    exercise and variant, and the best set of the 30 days before `date`.
    Sets left empty don't count."""
    sets = variant_sets(conn, exercise_id, variant_id)
    measure = metric(kind, sets)
    earlier = [s for s in sets if s["workout_date"] < date and any(s[k] is not None for k in SET_FIELDS)]
    last = None
    if earlier:
        last_date = earlier[-1]["workout_date"]
        last = {"date": last_date, "sets": [plain_set(s) for s in earlier if s["workout_date"] == last_date]}
    since = (datetime.date.fromisoformat(date) - datetime.timedelta(days=RECENT_DAYS)).isoformat()
    return {
        "metric": measure,
        "last": last,
        "max30": best(kind, measure, [s for s in earlier if s["workout_date"] >= since]),
    }


# ---- workouts -----------------------------------------------------------------


def workout_detail(conn, date):
    """The workout on `date`, or an empty one (id None) if there's none yet."""
    workout = db.row(conn.execute("SELECT id, workout_date, tiredness, notes FROM workouts WHERE workout_date = ?", (date,)))
    if workout is None:
        return {"id": None, "workout_date": date, "tiredness": None, "notes": "", "blocks": []}
    blocks = db.rows(conn.execute(
        """SELECT we.id, we.exercise_id, we.variant_id, we.position,
                  e.name AS exercise_name, e.kind, v.name AS variant_name
           FROM workout_exercises we
           JOIN exercises e ON e.id = we.exercise_id
           LEFT JOIN exercise_variants v ON v.id = we.variant_id
           WHERE we.workout_id = ? ORDER BY we.position, we.id""",
        (workout["id"],),
    ))
    for b in blocks:
        b["sets"] = db.rows(conn.execute(
            "SELECT id, position, reps, weight, seconds, edge_mm FROM workout_sets WHERE workout_exercise_id = ? "
            "ORDER BY position, id", (b["id"],)))
        b["reference"] = reference(conn, b["kind"], b["exercise_id"], b["variant_id"], date)
    workout["blocks"] = blocks
    return workout


def ensure_workout(conn, date):
    conn.execute("INSERT INTO workouts (workout_date) VALUES (?) ON CONFLICT (workout_date) DO NOTHING", (date,))
    return conn.execute("SELECT id FROM workouts WHERE workout_date = ?", (date,)).fetchone()["id"]


def drop_if_empty(conn, workout_id):
    """A workout left with no exercises, tiredness or notes goes, so its day
    isn't marked on the calendar."""
    conn.execute(
        """DELETE FROM workouts WHERE id = ? AND tiredness IS NULL AND notes = ''
           AND NOT EXISTS (SELECT 1 FROM workout_exercises WHERE workout_id = workouts.id)""",
        (workout_id,),
    )


def set_values(kind, data, existing=None):
    """A set's columns from `data`, over `existing`, keeping only those its kind uses."""
    values = {k: (existing or {}).get(k) for k in SET_FIELDS}
    for key in SET_FIELDS:
        if key not in data:
            continue
        raw = data[key]
        if raw in (None, ""):
            values[key] = None
        elif key == "reps":
            reps = optional_int(raw)
            if not 0 <= reps <= REPS_MAX:
                bad_request("Reps must be between 0 and %d" % REPS_MAX)
            values[key] = reps
        elif key == "weight":
            values[key] = parse_float(raw, "Weight", 0 if kind == "weight" else WEIGHT_MIN, WEIGHT_MAX)
        elif key == "seconds":
            values[key] = parse_float(raw, "Seconds", 0, SECONDS_MAX)
        else:
            values[key] = parse_float(raw, "Edge", EDGE_MIN, EDGE_MAX)
    for key in SET_FIELDS:
        if key not in KIND_FIELDS[kind]:
            values[key] = None
    return values


@bp.get("/api/workouts/<date>")
@admin_required
def get_workout(date):
    return jsonify(workout_detail(db.get_db(), parse_date(date, "Date")))


@bp.put("/api/workouts/<date>")
@admin_required
def update_workout(date):
    """Tiredness (1–5, or null) and notes; makes the day's workout if needed."""
    conn = db.get_db()
    date = parse_date(date, "Date")
    data = request.get_json(silent=True) or {}
    workout_id = ensure_workout(conn, date)
    if "tiredness" in data:
        tiredness = optional_int(data["tiredness"])
        if tiredness is not None and not 1 <= tiredness <= 5:
            bad_request("Tiredness goes from 1 to 5")
        conn.execute("UPDATE workouts SET tiredness = ? WHERE id = ?", (tiredness, workout_id))
    if "notes" in data:
        conn.execute("UPDATE workouts SET notes = ? WHERE id = ?", (text(data, "notes", "Notes", NOTE_MAX), workout_id))
    drop_if_empty(conn, workout_id)
    conn.commit()
    return jsonify(workout_detail(conn, date))


@bp.delete("/api/workouts/<date>")
@admin_required
def delete_workout(date):
    conn = db.get_db()
    date = parse_date(date, "Date")
    if conn.execute("DELETE FROM workouts WHERE workout_date = ?", (date,)).rowcount == 0:
        not_found("No workout that day")
    conn.commit()
    return jsonify({"deleted": date})


@bp.post("/api/workouts/<date>/exercises")
@admin_required
def add_block(date):
    """Adds an exercise (and variant) to the day's workout, with one empty set."""
    conn = db.get_db()
    date = parse_date(date, "Date")
    data = request.get_json(silent=True) or {}
    exercise = get_exercise_or_404(conn, optional_int(data.get("exercise_id")))
    variant_id = optional_int(data.get("variant_id"))
    if variant_id is not None and get_variant_or_404(conn, variant_id)["exercise_id"] != exercise["id"]:
        bad_request("That variant belongs to another exercise")
    workout_id = ensure_workout(conn, date)
    if conn.execute("SELECT 1 FROM workout_exercises WHERE workout_id = ? AND exercise_id = ? AND variant_id IS ?",
                    (workout_id, exercise["id"], variant_id)).fetchone():
        bad_request("That's already in this workout")
    position = conn.execute("SELECT COALESCE(MAX(position) + 1, 0) FROM workout_exercises WHERE workout_id = ?",
                            (workout_id,)).fetchone()[0]
    block_id = conn.execute("INSERT INTO workout_exercises (workout_id, exercise_id, variant_id, position) VALUES (?, ?, ?, ?)",
                            (workout_id, exercise["id"], variant_id, position)).lastrowid
    conn.execute("INSERT INTO workout_sets (workout_exercise_id, position) VALUES (?, 0)", (block_id,))
    conn.commit()
    return jsonify(workout_detail(conn, date)), 201


@bp.delete("/api/workout-exercises/<int:block_id>")
@admin_required
def delete_block(block_id):
    conn = db.get_db()
    block = get_block_or_404(conn, block_id)
    conn.execute("DELETE FROM workout_exercises WHERE id = ?", (block_id,))
    drop_if_empty(conn, block["workout_id"])
    conn.commit()
    return jsonify(workout_detail(conn, block["workout_date"]))


@bp.post("/api/workout-exercises/<int:block_id>/sets")
@admin_required
def add_set(block_id):
    conn = db.get_db()
    block = get_block_or_404(conn, block_id)
    values = set_values(block["kind"], request.get_json(silent=True) or {})
    position = conn.execute("SELECT COALESCE(MAX(position) + 1, 0) FROM workout_sets WHERE workout_exercise_id = ?",
                            (block_id,)).fetchone()[0]
    set_id = conn.execute(
        "INSERT INTO workout_sets (workout_exercise_id, position, reps, weight, seconds, edge_mm) "
        "VALUES (:block, :position, :reps, :weight, :seconds, :edge_mm)",
        dict(values, block=block_id, position=position)).lastrowid
    conn.commit()
    return jsonify(plain_set(get_set_or_404(conn, set_id))), 201


@bp.put("/api/sets/<int:set_id>")
@admin_required
def update_set(set_id):
    conn = db.get_db()
    s = get_set_or_404(conn, set_id)
    values = set_values(s["kind"], request.get_json(silent=True) or {}, s)
    conn.execute("UPDATE workout_sets SET reps = :reps, weight = :weight, seconds = :seconds, edge_mm = :edge_mm "
                 "WHERE id = :id", dict(values, id=set_id))
    conn.commit()
    return jsonify(plain_set(get_set_or_404(conn, set_id)))


@bp.delete("/api/sets/<int:set_id>")
@admin_required
def delete_set(set_id):
    conn = db.get_db()
    get_set_or_404(conn, set_id)
    conn.execute("DELETE FROM workout_sets WHERE id = ?", (set_id,))
    conn.commit()
    return jsonify({"deleted": set_id})


# ---- exercises -----------------------------------------------------------------


def exercise_list(conn, exercise_id=None):
    """Exercises with their variants, how often each was done and when last
    (`last_date`, null if never). `plain_last_date` is when the exercise was
    last done without a variant: one that had none then, or has none at all."""
    where = "WHERE e.id = ?" if exercise_id is not None else ""
    exercises = db.rows(conn.execute(
        """SELECT e.id, e.name, e.kind, e.notes,
                  COUNT(we.id) AS times, MAX(w.workout_date) AS last_date,
                  MAX(CASE WHEN we.variant_id IS NULL THEN w.workout_date END) AS plain_last_date
           FROM exercises e
           LEFT JOIN workout_exercises we ON we.exercise_id = e.id
           LEFT JOIN workouts w ON w.id = we.workout_id
           %s GROUP BY e.id ORDER BY e.name COLLATE NOCASE""" % where,
        (exercise_id,) if exercise_id is not None else (),
    ))
    variants = {}
    for v in conn.execute(
        """SELECT v.id, v.exercise_id, v.name, v.position,
                  COUNT(we.id) AS times, MAX(w.workout_date) AS last_date
           FROM exercise_variants v
           LEFT JOIN workout_exercises we ON we.variant_id = v.id
           LEFT JOIN workouts w ON w.id = we.workout_id
           GROUP BY v.id ORDER BY v.position, v.id"""
    ):
        variants.setdefault(v["exercise_id"], []).append(
            {"id": v["id"], "name": v["name"], "times": v["times"], "last_date": v["last_date"]})
    for e in exercises:
        e["variants"] = variants.get(e["id"], [])
    return exercises


def exercise_detail(conn, exercise_id):
    found = exercise_list(conn, exercise_id)
    if not found:
        not_found("Exercise not found")
    return found[0]


def taken_exercise(conn, name, exclude_id=None):
    return conn.execute("SELECT 1 FROM exercises WHERE name = ? AND id IS NOT ?", (name, exclude_id)).fetchone()


def add_variant(conn, exercise_id, name):
    if conn.execute("SELECT 1 FROM exercise_variants WHERE exercise_id = ? AND name = ? COLLATE NOCASE",
                    (exercise_id, name)).fetchone():
        bad_request("It already has a variant called %s" % name)
    count, position = conn.execute(
        "SELECT COUNT(*), COALESCE(MAX(position) + 1, 0) FROM exercise_variants WHERE exercise_id = ?", (exercise_id,)).fetchone()
    if count >= MAX_VARIANTS:
        bad_request("An exercise can have at most %d variants" % MAX_VARIANTS)
    conn.execute("INSERT INTO exercise_variants (exercise_id, name, position) VALUES (?, ?, ?)", (exercise_id, name, position))


def parse_kind(data):
    if data.get("kind") not in KINDS:
        bad_request("Kind must be one of %s" % ", ".join(KINDS))
    return data["kind"]


@bp.get("/api/exercises")
@admin_required
def list_exercises():
    return jsonify(exercise_list(db.get_db()))


@bp.post("/api/exercises")
@admin_required
def create_exercise():
    """{name, kind, notes, variants: [names]}."""
    conn = db.get_db()
    data = request.get_json(silent=True) or {}
    name = clean_name(data, "name", "Name")
    if taken_exercise(conn, name):
        bad_request("There's already an exercise called %s" % name)
    exercise_id = conn.execute("INSERT INTO exercises (name, kind, notes) VALUES (?, ?, ?)",
                               (name, parse_kind(data), text(data, "notes", "Notes", NOTE_MAX))).lastrowid
    variants = data.get("variants") or []
    if not isinstance(variants, list):
        bad_request("variants must be a list of names")
    for v in variants:
        add_variant(conn, exercise_id, clean_name({"name": v}, "name", "Variant name"))
    conn.commit()
    return jsonify(exercise_detail(conn, exercise_id)), 201


@bp.put("/api/exercises/<int:exercise_id>")
@admin_required
def update_exercise(exercise_id):
    """Name and notes; the kind only while it's never been done (its sets' columns depend on it)."""
    conn = db.get_db()
    exercise = get_exercise_or_404(conn, exercise_id)
    data = request.get_json(silent=True) or {}
    if "name" in data:
        exercise["name"] = clean_name(data, "name", "Name")
        if taken_exercise(conn, exercise["name"], exclude_id=exercise_id):
            bad_request("There's already an exercise called %s" % exercise["name"])
    if "notes" in data:
        exercise["notes"] = text(data, "notes", "Notes", NOTE_MAX)
    if "kind" in data and data["kind"] != exercise["kind"]:
        exercise["kind"] = parse_kind(data)
        if conn.execute("SELECT 1 FROM workout_exercises WHERE exercise_id = ?", (exercise_id,)).fetchone():
            bad_request("It's been done in workouts, so how it's measured can't change")
    conn.execute("UPDATE exercises SET name = ?, notes = ?, kind = ? WHERE id = ?",
                 (exercise["name"], exercise["notes"], exercise["kind"], exercise_id))
    conn.commit()
    return jsonify(exercise_detail(conn, exercise_id))


@bp.delete("/api/exercises/<int:exercise_id>")
@admin_required
def delete_exercise(exercise_id):
    conn = db.get_db()
    get_exercise_or_404(conn, exercise_id)
    if conn.execute("SELECT 1 FROM workout_exercises WHERE exercise_id = ?", (exercise_id,)).fetchone():
        bad_request("It's been done in workouts, so it stays")
    conn.execute("DELETE FROM exercises WHERE id = ?", (exercise_id,))
    conn.commit()
    return jsonify({"deleted": exercise_id})


@bp.post("/api/exercises/<int:exercise_id>/variants")
@admin_required
def create_variant(exercise_id):
    conn = db.get_db()
    get_exercise_or_404(conn, exercise_id)
    add_variant(conn, exercise_id, clean_name(request.get_json(silent=True) or {}, "name", "Variant name"))
    conn.commit()
    return jsonify(exercise_detail(conn, exercise_id)), 201


@bp.put("/api/variants/<int:variant_id>")
@admin_required
def rename_variant(variant_id):
    conn = db.get_db()
    variant = get_variant_or_404(conn, variant_id)
    name = clean_name(request.get_json(silent=True) or {}, "name", "Variant name")
    if conn.execute("SELECT 1 FROM exercise_variants WHERE exercise_id = ? AND name = ? COLLATE NOCASE AND id != ?",
                    (variant["exercise_id"], name, variant_id)).fetchone():
        bad_request("It already has a variant called %s" % name)
    conn.execute("UPDATE exercise_variants SET name = ? WHERE id = ?", (name, variant_id))
    conn.commit()
    return jsonify(exercise_detail(conn, variant["exercise_id"]))


@bp.delete("/api/variants/<int:variant_id>")
@admin_required
def delete_variant(variant_id):
    conn = db.get_db()
    variant = get_variant_or_404(conn, variant_id)
    if conn.execute("SELECT 1 FROM workout_exercises WHERE variant_id = ?", (variant_id,)).fetchone():
        bad_request("It's been done in workouts, so it stays")
    conn.execute("DELETE FROM exercise_variants WHERE id = ?", (variant_id,))
    conn.commit()
    return jsonify(exercise_detail(conn, variant["exercise_id"]))


@bp.get("/api/exercises/<int:exercise_id>/progress")
@admin_required
def progress(exercise_id):
    """A series per variant done: each day's best, in its metric. Then the
    history, newest day first: each block's sets."""
    conn = db.get_db()
    exercise = exercise_detail(conn, exercise_id)
    kind = exercise["kind"]
    variant_ids = [r["variant_id"] for r in conn.execute(
        """SELECT DISTINCT we.variant_id FROM workout_exercises we LEFT JOIN exercise_variants v ON v.id = we.variant_id
           WHERE we.exercise_id = ? ORDER BY v.position IS NOT NULL, v.position""", (exercise_id,))]
    names = {v["id"]: v["name"] for v in exercise["variants"]}
    series = []
    for variant_id in variant_ids:
        sets = variant_sets(conn, exercise_id, variant_id)
        measure = metric(kind, sets)
        by_day = {}
        for s in sets:
            by_day.setdefault(s["workout_date"], []).append(s)
        points = [p for p in (best(kind, measure, day_sets) for day_sets in by_day.values()) if p]
        if points:
            series.append({"variant_id": variant_id, "variant_name": names.get(variant_id), "metric": measure, "points": points})
    history = db.rows(conn.execute(
        """SELECT we.id, w.workout_date, we.variant_id, v.name AS variant_name
           FROM workout_exercises we JOIN workouts w ON w.id = we.workout_id
           LEFT JOIN exercise_variants v ON v.id = we.variant_id
           WHERE we.exercise_id = ? ORDER BY w.workout_date DESC, we.position""", (exercise_id,)))
    for b in history:
        b["sets"] = db.rows(conn.execute(
            "SELECT id, position, reps, weight, seconds, edge_mm FROM workout_sets WHERE workout_exercise_id = ? "
            "ORDER BY position, id", (b.pop("id"),)))
    return jsonify({"exercise": exercise, "series": series, "history": history})
