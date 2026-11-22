"""The admin's finger health (schema.sql: finger_checks). Each finger gets a
score from 0 (healthy) to 10 (most painful) at the start of a day's session
and at its end, or only at the end on a rest day, with a comment on how the
fingers feel. The calendar draws the day's hands from these (calendar.js).
Only the admin, logged in, sees any of it (auth.py)."""

import json

from flask import Blueprint, jsonify, request

import db
from auth import admin_required
from helpers import bad_request, not_found, parse_date, text

bp = Blueprint("fingers", __name__)

# The order of a check's scores (hands.js FINGER_NAMES).
FINGERS = (
    "left thumb", "left index", "left middle", "left ring", "left pinky",
    "right thumb", "right index", "right middle", "right ring", "right pinky",
)
PHASES = ("start", "end")
SCORE_MIN, SCORE_MAX = 0, 10
COMMENT_MAX = 2000


def serialize(check):
    return {"scores": json.loads(check["scores"]), "comment": check["comment"], "updated_at": check["updated_at"]}


def dated(check):
    return {"date": check["check_date"], "phase": check["phase"], **serialize(check)}


def checks_by_day(conn, date=None):
    """{date: {"start": check or None, "end": check or None}}, for one date or all."""
    rows = conn.execute(
        "SELECT * FROM finger_checks" + (" WHERE check_date = ?" if date else ""), (date,) if date else ())
    days = {}
    for r in rows:
        days.setdefault(r["check_date"], {"start": None, "end": None})[r["phase"]] = serialize(r)
    return days


def parse_phase(phase):
    if phase not in PHASES:
        not_found("A check is for the start or the end of a session")
    return phase


def parse_scores(raw):
    if not isinstance(raw, list) or len(raw) != len(FINGERS):
        bad_request("scores must be a list of %d scores" % len(FINGERS))
    for score in raw:
        if not isinstance(score, int) or isinstance(score, bool) or not SCORE_MIN <= score <= SCORE_MAX:
            bad_request("Each score goes from %d to %d" % (SCORE_MIN, SCORE_MAX))
    return raw


def day_detail(conn, date):
    return checks_by_day(conn, date).get(date, {"start": None, "end": None})


def last_check_before(conn, date):
    """The latest check on an earlier day (its end over its start), or None."""
    row = conn.execute(
        "SELECT * FROM finger_checks WHERE check_date < ? ORDER BY check_date DESC, phase = 'end' DESC LIMIT 1",
        (date,)).fetchone()
    return row and dated(row)


@bp.get("/api/fingers")
@admin_required
def list_checks():
    """Every check, the newest first (a day's end over its start), for the
    history under the form (fingers.js)."""
    rows = db.get_db().execute("SELECT * FROM finger_checks ORDER BY check_date DESC, phase = 'end' DESC")
    return jsonify({"checks": [dated(r) for r in rows]})


@bp.get("/api/fingers/<date>")
@admin_required
def get_day(date):
    """The day's checks, plus `previous`: the last one before the day, which a
    new check starts from (fingers.js)."""
    conn = db.get_db()
    date = parse_date(date, "Date")
    return jsonify({**day_detail(conn, date), "previous": last_check_before(conn, date)})


@bp.put("/api/fingers/<date>/<phase>")
@admin_required
def save_check(date, phase):
    conn = db.get_db()
    date = parse_date(date, "Date")
    phase = parse_phase(phase)
    data = request.get_json(silent=True) or {}
    scores = parse_scores(data.get("scores"))
    comment = text(data, "comment", "Comment", COMMENT_MAX)
    conn.execute(
        """INSERT INTO finger_checks (check_date, phase, scores, comment) VALUES (?, ?, ?, ?)
           ON CONFLICT (check_date, phase) DO UPDATE
           SET scores = excluded.scores, comment = excluded.comment, updated_at = datetime('now')""",
        (date, phase, json.dumps(scores), comment),
    )
    conn.commit()
    return jsonify(day_detail(conn, date))


@bp.delete("/api/fingers/<date>/<phase>")
@admin_required
def delete_check(date, phase):
    conn = db.get_db()
    date = parse_date(date, "Date")
    phase = parse_phase(phase)
    if conn.execute("DELETE FROM finger_checks WHERE check_date = ? AND phase = ?", (date, phase)).rowcount == 0:
        not_found("No %s-of-session check that day" % phase)
    conn.commit()
    return jsonify(day_detail(conn, date))
