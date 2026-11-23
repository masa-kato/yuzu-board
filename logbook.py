"""Climbers and what they climb (schema.sql: climbers, sends, tries): the
logbook, the calendars' days, and the first-ascent bookkeeping. Repeats
aren't stored: a send is a repeat when its climber sent the climb before.
Only the admin, logged in, can log sends and tries as the admin (auth.py)."""

from flask import Blueprint, jsonify, request

import auth
import db
import fingers
from climbs import POSSIBLE_SQL, display_name, get_route_or_404, removed_holds
from helpers import bad_request, not_found, optional_int, parse_date, require_climber, text

bp = Blueprint("logbook", __name__)


# ---- first-ascent bookkeeping ---------------------------------------------------


def recompute_fa(conn, route_id):
    first = db.row(conn.execute(
        "SELECT climber_id, sent_date FROM sends WHERE route_id = ? ORDER BY sent_date, id LIMIT 1",
        (route_id,),
    ))
    conn.execute(
        "UPDATE routes SET fa_climber_id = ?, fa_date = ? WHERE id = ?",
        (first and first["climber_id"], first and first["sent_date"], route_id),
    )


def claim_fa_if_first(conn, route_id, climber_id, sent_date):
    """Make this send the first ascent if the route has none yet, or if it
    predates the recorded one. Returns True when it became the FA."""
    route = get_route_or_404(conn, route_id)
    if route["fa_date"] is None or sent_date < route["fa_date"]:
        conn.execute(
            "UPDATE routes SET fa_climber_id = ?, fa_date = ? WHERE id = ?",
            (climber_id, sent_date, route_id),
        )
        return True
    return False


def is_fa_send(route, send):
    return route["fa_climber_id"] == send["climber_id"] and route["fa_date"] == send["sent_date"]


# ---- climbers -------------------------------------------------------------------


# The admin is flagged, as choosing them asks for their password (auth.py).
@bp.get("/api/climbers")
def list_climbers():
    climbers = db.rows(db.get_db().execute("SELECT id, name FROM climbers ORDER BY name COLLATE NOCASE"))
    admin_id = auth.admin_climber_id()
    for c in climbers:
        c["is_admin"] = c["id"] == admin_id
    return jsonify(climbers)


@bp.post("/api/climbers")
def create_climber():
    name = ((request.get_json(silent=True) or {}).get("name") or "").strip()
    if not name:
        bad_request("Name is required")
    conn = db.get_db()
    existing = db.row(conn.execute("SELECT id, name FROM climbers WHERE name = ?", (name,)))
    if existing:
        return jsonify(existing)
    cur = conn.execute("INSERT INTO climbers (name) VALUES (?)", (name,))
    conn.commit()
    return jsonify({"id": cur.lastrowid, "name": name}), 201


@bp.get("/api/climbers/<int:climber_id>/sends")
def climber_log(climber_id):
    conn = db.get_db()
    climber = db.row(conn.execute("SELECT id, name FROM climbers WHERE id = ?", (climber_id,)))
    if climber is None:
        not_found("Climber not found")
    sends = db.rows(conn.execute(
        """
        WITH ranked AS (
            SELECT s.*, ROW_NUMBER() OVER (
                PARTITION BY s.route_id, s.climber_id ORDER BY s.sent_date, s.id
            ) AS nth
            FROM sends s
        )
        SELECT ranked.id, ranked.route_id, ranked.climber_id, ranked.sent_date, ranked.comment,
               ranked.nth > 1 AS is_repeat,
               (ranked.nth = 1 AND r.fa_climber_id = ranked.climber_id) AS is_fa,
               r.name, r.grade, r.parent_id, parent.name AS parent_name,
               %s AS possible
        FROM ranked
        JOIN routes r ON r.id = ranked.route_id
        LEFT JOIN routes parent ON parent.id = r.parent_id
        WHERE ranked.climber_id = ?
        ORDER BY ranked.sent_date DESC, ranked.id DESC
        """ % POSSIBLE_SQL,
        (climber_id,),
    ))
    for s in sends:
        s["is_repeat"] = bool(s["is_repeat"])
        s["is_fa"] = bool(s["is_fa"])
        s["possible"] = bool(s["possible"])
        s["display_name"] = display_name(s["name"], s["parent_name"])
    tries = db.rows(conn.execute(
        """
        SELECT t.id, t.route_id, t.climber_id, t.tried_date, t.note,
               r.name, r.grade, r.parent_id, parent.name AS parent_name,
               %s AS possible
        FROM tries t
        JOIN routes r ON r.id = t.route_id
        LEFT JOIN routes parent ON parent.id = r.parent_id
        WHERE t.climber_id = ?
        ORDER BY t.tried_date DESC, t.id DESC
        """ % POSSIBLE_SQL,
        (climber_id,),
    ))
    for t in tries:
        t["possible"] = bool(t["possible"])
        t["display_name"] = display_name(t["name"], t["parent_name"])
    return jsonify({
        "climber": climber,
        "sends": sends,
        "tries": tries,
        "summary": {
            "total_sends": len(sends),
            "unique_climbs": len({s["route_id"] for s in sends}),
            "first_ascents": sum(1 for s in sends if s["is_fa"]),
        },
    })


# What a climber did each day, for the calendars: {date: {sends, tries,
# outdoor, workout}}, plus `fingers` ({start, end}, fingers.py) on days with
# a finger check. Outdoor sessions, workouts and finger checks are the
# admin's alone, so they're only on the admin's own days, logged in.
@bp.get("/api/climbers/<int:climber_id>/days")
def climber_days(climber_id):
    conn = db.get_db()
    if db.row(conn.execute("SELECT id FROM climbers WHERE id = ?", (climber_id,))) is None:
        not_found("Climber not found")
    queries = [
        ("sends", "SELECT sent_date AS day, COUNT(*) AS n FROM sends WHERE climber_id = ? GROUP BY sent_date", (climber_id,)),
        ("tries", "SELECT tried_date AS day, COUNT(*) AS n FROM tries WHERE climber_id = ? GROUP BY tried_date", (climber_id,)),
    ]
    mine = auth.is_admin() and climber_id == auth.admin_climber_id()
    if mine:
        queries += [
            ("outdoor", "SELECT session_date AS day, COUNT(*) AS n FROM outdoor_sessions GROUP BY session_date", ()),
            ("workout", "SELECT workout_date AS day, 1 AS n FROM workouts", ()),
        ]
    days = {}
    for key, sql, args in queries:
        for r in conn.execute(sql, args):
            day = days.setdefault(r["day"], {"sends": 0, "tries": 0, "outdoor": 0, "workout": False})
            day[key] = bool(r["n"]) if key == "workout" else r["n"]
    if mine:
        for date, checks in fingers.checks_by_day(conn).items():
            days.setdefault(date, {"sends": 0, "tries": 0, "outdoor": 0, "workout": False})["fingers"] = checks
    return jsonify({"days": days})


# ---- sends ----------------------------------------------------------------------


def get_send_or_404(conn, send_id):
    send = db.row(conn.execute("SELECT * FROM sends WHERE id = ?", (send_id,)))
    if send is None:
        not_found("Send not found")
    return send


@bp.post("/api/sends")
def create_send():
    conn = db.get_db()
    data = request.get_json(silent=True) or {}
    route_id = optional_int(data.get("route_id"))
    climber_id = optional_int(data.get("climber_id"))
    if route_id is None or climber_id is None:
        bad_request("route_id and climber_id are required")
    get_route_or_404(conn, route_id)
    if removed_holds(conn, [route_id])[route_id]:
        bad_request("This climb is no longer possible — it uses a hold that was removed from the wall")
    require_climber(conn, climber_id, "climber_id")
    auth.guard_climber(climber_id)
    sent_date = parse_date(data.get("sent_date"), "Send date")
    repeat = db.row(conn.execute(
        "SELECT 1 FROM sends WHERE route_id = ? AND climber_id = ? AND sent_date <= ?",
        (route_id, climber_id, sent_date),
    )) is not None
    cur = conn.execute(
        "INSERT INTO sends (route_id, climber_id, sent_date, comment) VALUES (?, ?, ?, ?)",
        (route_id, climber_id, sent_date, (data.get("comment") or "").strip()),
    )
    became_fa = claim_fa_if_first(conn, route_id, climber_id, sent_date)
    conn.commit()
    return jsonify({"id": cur.lastrowid, "is_fa": became_fa, "is_repeat": repeat}), 201


@bp.put("/api/sends/<int:send_id>")
def update_send(send_id):
    conn = db.get_db()
    send = get_send_or_404(conn, send_id)
    auth.guard_climber(send["climber_id"])
    route = get_route_or_404(conn, send["route_id"])
    data = request.get_json(silent=True) or {}
    updated = dict(send)
    if "sent_date" in data:
        updated["sent_date"] = parse_date(data["sent_date"], "Send date")
    if "comment" in data:
        updated["comment"] = (data.get("comment") or "").strip()
    if "climber_id" in data:
        updated["climber_id"] = require_climber(conn, optional_int(data["climber_id"]), "climber_id")
        auth.guard_climber(updated["climber_id"])
    conn.execute(
        "UPDATE sends SET sent_date = ?, comment = ?, climber_id = ? WHERE id = ?",
        (updated["sent_date"], updated["comment"], updated["climber_id"], send_id),
    )
    if is_fa_send(route, send):
        recompute_fa(conn, route["id"])
    else:
        claim_fa_if_first(conn, route["id"], updated["climber_id"], updated["sent_date"])
    conn.commit()
    return jsonify({"id": send_id})


@bp.delete("/api/sends/<int:send_id>")
def delete_send(send_id):
    conn = db.get_db()
    send = get_send_or_404(conn, send_id)
    auth.guard_climber(send["climber_id"])
    route = get_route_or_404(conn, send["route_id"])
    conn.execute("DELETE FROM sends WHERE id = ?", (send_id,))
    if is_fa_send(route, send):
        recompute_fa(conn, route["id"])
    conn.commit()
    return jsonify({"deleted": send_id})


# ---- tries ----------------------------------------------------------------------
# A mark that a climber tried a climb on a day (schema.sql): one per day,
# so marking it again that day just updates the note.


def get_try_or_404(conn, try_id):
    t = db.row(conn.execute("SELECT * FROM tries WHERE id = ?", (try_id,)))
    if t is None:
        not_found("Try not found")
    return t


@bp.post("/api/tries")
def create_try():
    conn = db.get_db()
    data = request.get_json(silent=True) or {}
    route_id = optional_int(data.get("route_id"))
    climber_id = optional_int(data.get("climber_id"))
    if route_id is None or climber_id is None:
        bad_request("route_id and climber_id are required")
    get_route_or_404(conn, route_id)
    if removed_holds(conn, [route_id])[route_id]:
        bad_request("This climb is no longer possible — it uses a hold that was removed from the wall")
    require_climber(conn, climber_id, "climber_id")
    auth.guard_climber(climber_id)
    tried_date = parse_date(data.get("tried_date"), "Date")
    note = text(data, "note", "Note")
    conn.execute(
        """INSERT INTO tries (route_id, climber_id, tried_date, note) VALUES (?, ?, ?, ?)
           ON CONFLICT (route_id, climber_id, tried_date) DO UPDATE SET note = excluded.note""",
        (route_id, climber_id, tried_date, note),
    )
    conn.commit()
    t = db.row(conn.execute("SELECT * FROM tries WHERE route_id = ? AND climber_id = ? AND tried_date = ?",
                            (route_id, climber_id, tried_date)))
    return jsonify(t), 201


@bp.put("/api/tries/<int:try_id>")
def update_try(try_id):
    conn = db.get_db()
    t = get_try_or_404(conn, try_id)
    auth.guard_climber(t["climber_id"])
    data = request.get_json(silent=True) or {}
    if "tried_date" in data:
        t["tried_date"] = parse_date(data["tried_date"], "Date")
    if "note" in data:
        t["note"] = text(data, "note", "Note")
    clash = conn.execute("SELECT 1 FROM tries WHERE route_id = ? AND climber_id = ? AND tried_date = ? AND id != ?",
                         (t["route_id"], t["climber_id"], t["tried_date"], try_id)).fetchone()
    if clash:
        bad_request("It's already marked tried that day")
    conn.execute("UPDATE tries SET tried_date = ?, note = ? WHERE id = ?", (t["tried_date"], t["note"], try_id))
    conn.commit()
    return jsonify(t)


@bp.delete("/api/tries/<int:try_id>")
def delete_try(try_id):
    conn = db.get_db()
    t = get_try_or_404(conn, try_id)
    auth.guard_climber(t["climber_id"])
    conn.execute("DELETE FROM tries WHERE id = ?", (try_id,))
    conn.commit()
    return jsonify({"deleted": try_id})
