"""The admin's outdoor climbing (schema.sql: outdoor_climbs, outdoor_sessions,
outdoor_entries). A session is a day out at an area, listing the climbs tried
that day, sent or not, each with a note on what was learned on it; a climb's
page gathers its notes from every session. Each entry knows which session on
its climb it was (Hagakure's 5th), counting the climb's sessions before any
were logged here. Only the admin, logged in, sees any of it (auth.py)."""

from flask import Blueprint, jsonify, request

import db
from auth import admin_required
from helpers import bad_request, not_found, optional_int, parse_date, text

bp = Blueprint("outdoor", __name__)

NAME_MAX = 120
GRADE_MAX = 20
NOTE_MAX = 4000
MAX_ENTRIES = 100   # climbs in one session
PRIOR_MAX = 999     # sessions on a climb before any were logged here

# Which session on its climb an entry `e` (of session `s`, climb `c`) was: the
# climb's sessions before any were logged here, then its logged ones by date
# (two on one day in the order they were logged). A climb is its name in its
# area, so a same-named climb elsewhere counts its own.
SESSION_NUMBER = """c.prior_sessions + (
    SELECT COUNT(*) FROM outdoor_entries e2 JOIN outdoor_sessions s2 ON s2.id = e2.session_id
    WHERE e2.climb_id = e.climb_id AND (s2.session_date, s2.id) <= (s.session_date, s.id)
)"""

# A climb with its sessions; `sent_session` is the one it was first sent on
# (it took 6), null until it's sent.
CLIMB_SELECT = """
    SELECT c.id, c.name, c.area, c.grade, c.notes, c.prior_sessions,
           COUNT(e.id) AS session_count,
           MAX(s.session_date) AS last_date,
           MIN(CASE WHEN e.sent THEN s.session_date END) AS first_sent,
           firsts.sent_session
    FROM outdoor_climbs c
    LEFT JOIN outdoor_entries e ON e.climb_id = c.id
    LEFT JOIN outdoor_sessions s ON s.id = e.session_id
    LEFT JOIN (
        SELECT e.climb_id, MIN(%s) AS sent_session
        FROM outdoor_entries e JOIN outdoor_sessions s ON s.id = e.session_id JOIN outdoor_climbs c ON c.id = e.climb_id
        WHERE e.sent GROUP BY e.climb_id
    ) firsts ON firsts.climb_id = c.id
""" % SESSION_NUMBER


def get_climb_or_404(conn, climb_id):
    climb = db.row(conn.execute(CLIMB_SELECT + " WHERE c.id = ? GROUP BY c.id", (climb_id,)))
    if climb is None:
        not_found("Climb not found")
    return climb


def get_session_or_404(conn, session_id):
    session = db.row(conn.execute("SELECT * FROM outdoor_sessions WHERE id = ?", (session_id,)))
    if session is None:
        not_found("Session not found")
    return session


def climb_fields(data, existing=None):
    """A climb's name, area, grade, notes and sessions before logging here
    from `data`, over `existing`."""
    fields = dict(existing or {"name": "", "area": "", "grade": "", "notes": "", "prior_sessions": 0})
    for key, field, max_length in (("name", "Name", NAME_MAX), ("area", "Area", NAME_MAX),
                                   ("grade", "Grade", GRADE_MAX), ("notes", "Notes", NOTE_MAX)):
        if key in data:
            value = text(data, key, field, max_length)
            fields[key] = value if key == "notes" else " ".join(value.split())
    if "prior_sessions" in data:
        prior = optional_int(data["prior_sessions"]) or 0
        if not 0 <= prior <= PRIOR_MAX:
            bad_request("Sessions before logging must be between 0 and %d" % PRIOR_MAX)
        fields["prior_sessions"] = prior
    if not fields["name"]:
        bad_request("A climb needs a name")
    return fields


def same_climb(conn, name, area, exclude_id=None):
    return db.row(conn.execute(
        "SELECT id FROM outdoor_climbs WHERE name = ? COLLATE NOCASE AND area = ? COLLATE NOCASE AND id IS NOT ?",
        (name, area, exclude_id),
    ))


def climb_for_entry(conn, item):
    """The id of the climb a session entry is for: {climb_id}, or a new climb
    {climb: {name, area, grade}}, which is the existing one if that area
    already has a climb of that name."""
    climb_id = optional_int(item.get("climb_id"))
    if climb_id is not None:
        if conn.execute("SELECT 1 FROM outdoor_climbs WHERE id = ?", (climb_id,)).fetchone() is None:
            bad_request("An entry refers to an unknown climb")
        return climb_id
    new = item.get("climb")
    if not isinstance(new, dict):
        bad_request("Each entry needs a climb_id or a new climb")
    fields = climb_fields(new)
    existing = same_climb(conn, fields["name"], fields["area"])
    if existing:
        return existing["id"]
    return insert_climb(conn, fields)


def insert_climb(conn, fields):
    return conn.execute(
        "INSERT INTO outdoor_climbs (name, area, grade, notes, prior_sessions) "
        "VALUES (:name, :area, :grade, :notes, :prior_sessions)", fields).lastrowid


def write_entries(conn, session_id, raw):
    if not isinstance(raw, list):
        bad_request("entries must be a list")
    if len(raw) > MAX_ENTRIES:
        bad_request("A session can list at most %d climbs" % MAX_ENTRIES)
    rows = []
    for position, item in enumerate(raw):
        if not isinstance(item, dict):
            bad_request("Each entry must be an object")
        climb_id = climb_for_entry(conn, item)
        if any(r[0] == climb_id for r in rows):
            bad_request("A climb is in this session twice")
        rows.append((climb_id, 1 if item.get("sent") else 0, text(item, "note", "Note", NOTE_MAX), position))
    conn.execute("DELETE FROM outdoor_entries WHERE session_id = ?", (session_id,))
    conn.executemany("INSERT INTO outdoor_entries (session_id, climb_id, sent, note, position) VALUES (?, ?, ?, ?, ?)",
                     [(session_id,) + r for r in rows])


def session_entries(conn, session_ids):
    """{session_id: [entry, ...]} in each session's order."""
    result = {sid: [] for sid in session_ids}
    if not session_ids:
        return result
    for e in conn.execute(
        """SELECT e.session_id, e.climb_id, e.sent, e.note, c.name, c.area, c.grade, %s AS session_number
           FROM outdoor_entries e JOIN outdoor_climbs c ON c.id = e.climb_id JOIN outdoor_sessions s ON s.id = e.session_id
           WHERE e.session_id IN (%s) ORDER BY e.position, e.id""" % (SESSION_NUMBER, ",".join("?" * len(session_ids))),
        list(session_ids),
    ):
        entry = dict(e)
        entry["sent"] = bool(entry["sent"])
        result[entry.pop("session_id")].append(entry)
    return result


def serialize_sessions(conn, sessions):
    entries = session_entries(conn, [s["id"] for s in sessions])
    for s in sessions:
        s["entries"] = entries[s["id"]]
    return sessions


def session_fields(data, existing=None):
    fields = dict(existing or {"session_date": None, "area": "", "notes": ""})
    if "session_date" in data or existing is None:
        fields["session_date"] = parse_date(data.get("session_date"), "Date")
    if "area" in data:
        fields["area"] = " ".join(text(data, "area", "Area", NAME_MAX).split())
    if "notes" in data:
        fields["notes"] = text(data, "notes", "Notes", NOTE_MAX)
    return fields


# ---- sessions -------------------------------------------------------------


@bp.get("/api/outdoor/sessions")
@admin_required
def list_sessions():
    conn = db.get_db()
    sessions = db.rows(conn.execute("SELECT * FROM outdoor_sessions ORDER BY session_date DESC, id DESC"))
    return jsonify(serialize_sessions(conn, sessions))


@bp.get("/api/outdoor/sessions/<int:session_id>")
@admin_required
def get_session(session_id):
    conn = db.get_db()
    return jsonify(serialize_sessions(conn, [get_session_or_404(conn, session_id)])[0])


@bp.post("/api/outdoor/sessions")
@admin_required
def create_session():
    conn = db.get_db()
    data = request.get_json(silent=True) or {}
    fields = session_fields(data)
    session_id = conn.execute(
        "INSERT INTO outdoor_sessions (session_date, area, notes) VALUES (:session_date, :area, :notes)", fields).lastrowid
    write_entries(conn, session_id, data.get("entries", []))
    conn.commit()
    return jsonify(serialize_sessions(conn, [get_session_or_404(conn, session_id)])[0]), 201


@bp.put("/api/outdoor/sessions/<int:session_id>")
@admin_required
def update_session(session_id):
    conn = db.get_db()
    data = request.get_json(silent=True) or {}
    fields = session_fields(data, get_session_or_404(conn, session_id))
    conn.execute("UPDATE outdoor_sessions SET session_date = :session_date, area = :area, notes = :notes WHERE id = :id",
                 fields)
    if "entries" in data:
        write_entries(conn, session_id, data["entries"])
    conn.commit()
    return jsonify(serialize_sessions(conn, [get_session_or_404(conn, session_id)])[0])


@bp.delete("/api/outdoor/sessions/<int:session_id>")
@admin_required
def delete_session(session_id):
    conn = db.get_db()
    get_session_or_404(conn, session_id)
    conn.execute("DELETE FROM outdoor_sessions WHERE id = ?", (session_id,))
    conn.commit()
    return jsonify({"deleted": session_id})


# ---- climbs ---------------------------------------------------------------


def serialize_climb(c):
    c["sent"] = c["first_sent"] is not None
    # Every session on it: `session_count` is just the ones logged here.
    c["total_sessions"] = c["prior_sessions"] + c["session_count"]
    return c


@bp.get("/api/outdoor/climbs")
@admin_required
def list_climbs():
    conn = db.get_db()
    climbs = db.rows(conn.execute(CLIMB_SELECT + " GROUP BY c.id ORDER BY c.area COLLATE NOCASE, c.name COLLATE NOCASE"))
    return jsonify([serialize_climb(c) for c in climbs])


# A climb with every session it was tried in, newest first: its note from
# each, and the day's notes.
@bp.get("/api/outdoor/climbs/<int:climb_id>")
@admin_required
def get_climb(climb_id):
    conn = db.get_db()
    climb = serialize_climb(get_climb_or_404(conn, climb_id))
    climb["history"] = db.rows(conn.execute(
        """SELECT s.id AS session_id, s.session_date, s.area, s.notes AS session_notes, e.sent, e.note,
                  %s AS session_number
           FROM outdoor_entries e JOIN outdoor_sessions s ON s.id = e.session_id JOIN outdoor_climbs c ON c.id = e.climb_id
           WHERE e.climb_id = ? ORDER BY s.session_date DESC, s.id DESC""" % SESSION_NUMBER,
        (climb_id,),
    ))
    for h in climb["history"]:
        h["sent"] = bool(h["sent"])
    return jsonify(climb)


@bp.post("/api/outdoor/climbs")
@admin_required
def create_climb():
    conn = db.get_db()
    fields = climb_fields(request.get_json(silent=True) or {})
    if same_climb(conn, fields["name"], fields["area"]):
        bad_request("There's already a climb called %s there" % fields["name"])
    climb_id = insert_climb(conn, fields)
    conn.commit()
    return jsonify(serialize_climb(get_climb_or_404(conn, climb_id))), 201


@bp.put("/api/outdoor/climbs/<int:climb_id>")
@admin_required
def update_climb(climb_id):
    conn = db.get_db()
    climb = get_climb_or_404(conn, climb_id)
    fields = climb_fields(request.get_json(silent=True) or {},
                          {k: climb[k] for k in ("name", "area", "grade", "notes", "prior_sessions")})
    if same_climb(conn, fields["name"], fields["area"], exclude_id=climb_id):
        bad_request("There's already a climb called %s there" % fields["name"])
    conn.execute("UPDATE outdoor_climbs SET name = :name, area = :area, grade = :grade, notes = :notes, "
                 "prior_sessions = :prior_sessions WHERE id = :id", dict(fields, id=climb_id))
    conn.commit()
    return jsonify(serialize_climb(get_climb_or_404(conn, climb_id)))


@bp.delete("/api/outdoor/climbs/<int:climb_id>")
@admin_required
def delete_climb(climb_id):
    """Also takes it out of the sessions it was in."""
    conn = db.get_db()
    get_climb_or_404(conn, climb_id)
    conn.execute("DELETE FROM outdoor_climbs WHERE id = ?", (climb_id,))
    conn.commit()
    return jsonify({"deleted": climb_id})
