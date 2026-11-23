"""Climbs (schema.sql: routes, route_holds) and drafts (drafts, draft_holds).
A climb with parent_id set is a variation of that base problem; a problem
and its variations are a family. A climb is possible while none of its holds
has been removed from the wall, and a family is Legacy once none of its
climbs is. Drafts are climbs still being set, kept apart from `routes`."""

from flask import Blueprint, jsonify, request

import db
from constants import GRADES, ROLES
from helpers import bad_request, not_found, optional_int, parse_date, require_climber

bp = Blueprint("climbs", __name__)

# Sort keys for the climb list. `ascents` counts each climber once; `sends`
# counts every send, repeats included.
SORT_KEYS = {
    "set_date": lambda r: r["set_date"],
    "grade": lambda r: GRADES.index(r["grade"]),
    "fa_date": lambda r: r["fa_date"],
    "ascents": lambda r: r["ascent_count"],
    "sends": lambda r: r["send_count"],
}


def display_name(name, parent_name):
    return "%s — %s" % (parent_name, name) if parent_name else name


def get_route_or_404(conn, route_id):
    route = db.row(conn.execute("SELECT * FROM routes WHERE id = ?", (route_id,)))
    if route is None:
        not_found("Route not found")
    return route


# A climb is possible while none of its holds has been removed from the wall.
POSSIBLE_SQL = """NOT EXISTS (
    SELECT 1 FROM route_holds prh JOIN holds ph ON ph.id = prh.hold_id
    WHERE prh.route_id = r.id AND ph.removed_at IS NOT NULL)"""

ROUTE_SELECT = """
    SELECT r.id, r.name, r.parent_id, r.grade, r.set_date, r.notes,
           r.setter_id, setter.name AS setter_name,
           r.fa_climber_id, fa.name AS fa_name, r.fa_date,
           parent.name AS parent_name,
           (SELECT COUNT(*) FROM sends WHERE route_id = r.id) AS send_count,
           (SELECT COUNT(DISTINCT climber_id) FROM sends WHERE route_id = r.id) AS ascent_count,
           EXISTS (SELECT 1 FROM sends WHERE route_id = r.id AND climber_id = :me) AS sent_by_me,
           %s AS possible
    FROM routes r
    LEFT JOIN routes parent ON parent.id = r.parent_id
    LEFT JOIN climbers setter ON setter.id = r.setter_id
    LEFT JOIN climbers fa ON fa.id = r.fa_climber_id
""" % POSSIBLE_SQL


def decorate(route):
    route["display_name"] = display_name(route["name"], route.get("parent_name"))
    route["sent_by_me"] = bool(route.get("sent_by_me"))
    route["possible"] = bool(route.get("possible"))
    return route


def route_holds(conn, route_ids):
    """{route_id: [{hold_id, role}, ...]} for the given routes."""
    result = {rid: [] for rid in route_ids}
    if not route_ids:
        return result
    for rh in conn.execute(
        "SELECT route_id, hold_id, role FROM route_holds WHERE route_id IN (%s)" % db.in_clause(route_ids),
        list(route_ids),
    ):
        result[rh["route_id"]].append({"hold_id": rh["hold_id"], "role": rh["role"]})
    return result


def removed_holds(conn, route_ids):
    """{route_id: [names of removed holds the route uses]}."""
    result = {rid: [] for rid in route_ids}
    if not route_ids:
        return result
    for rh in conn.execute(
        """SELECT rh.route_id, h.name FROM route_holds rh JOIN holds h ON h.id = rh.hold_id
           WHERE h.removed_at IS NOT NULL AND rh.route_id IN (%s) ORDER BY h.name""" % db.in_clause(route_ids),
        list(route_ids),
    ):
        result[rh["route_id"]].append(rh["name"])
    return result


def clean_holds(conn, holds, keep=()):
    """A climb's holds as [(hold_id, role)]. Removed holds are only accepted
    if they were already on it (`keep`), so legacy routes stay editable but
    nobody can set a new climb on a hold that is gone."""
    if not isinstance(holds, list):
        bad_request("holds must be a list")
    seen = set()
    clean = []
    for item in holds:
        hold_id = optional_int(item.get("hold_id"))
        role = item.get("role")
        if role not in ROLES:
            bad_request("Hold role must be one of %s" % ", ".join(ROLES))
        if hold_id is None or hold_id in seen:
            continue
        seen.add(hold_id)
        clean.append((hold_id, role))
    known = {h["id"]: h for h in db.rows(conn.execute("SELECT id, name, removed_at FROM holds"))}
    for hold_id, _ in clean:
        hold = known.get(hold_id)
        if hold is None:
            bad_request("Route uses an unknown hold")
        if hold["removed_at"] and hold_id not in keep:
            bad_request("Hold %s has been removed from the wall" % hold["name"])
    return clean


def write_holds(conn, route_id, holds, keep=()):
    """Replace a route's holds (checked as clean_holds does)."""
    clean = clean_holds(conn, holds, keep)
    conn.execute("DELETE FROM route_holds WHERE route_id = ?", (route_id,))
    conn.executemany("INSERT INTO route_holds (route_id, hold_id, role) VALUES (?, ?, ?)",
                     [(route_id, hold_id, role) for hold_id, role in clean])


def sort_climbs(items, sort, descending, climb=lambda item: item):
    """Sort by SORT_KEYS[sort]; ties fall back to newest set first. Climbs
    without a value (no first ascent yet) always go last."""
    key = SORT_KEYS[sort]
    present = [i for i in items if key(climb(i)) is not None]
    missing = [i for i in items if key(climb(i)) is None]

    def newest(item):
        return climb(item)["set_date"], climb(item)["id"]

    for group in (present, missing):
        group.sort(key=newest, reverse=True)
    present.sort(key=lambda i: key(climb(i)), reverse=descending)
    return present + missing


def route_fields(conn, data, partial):
    fields = {}
    if "name" in data or not partial:
        name = (data.get("name") or "").strip()
        if not name:
            bad_request("Route name is required")
        fields["name"] = name
    if "grade" in data or not partial:
        if data.get("grade") not in GRADES:
            bad_request("Grade must be one of %s" % ", ".join(GRADES))
        fields["grade"] = data["grade"]
    if "set_date" in data or not partial:
        fields["set_date"] = parse_date(data.get("set_date"), "Set date")
    if "setter_id" in data:
        fields["setter_id"] = require_climber(conn, optional_int(data["setter_id"]), "setter_id")
    if "fa_climber_id" in data:
        fields["fa_climber_id"] = require_climber(conn, optional_int(data["fa_climber_id"]), "fa_climber_id")
    if "fa_date" in data:
        fields["fa_date"] = parse_date(data["fa_date"], "First ascent date") if data["fa_date"] else None
    if "notes" in data:
        fields["notes"] = (data.get("notes") or "").strip()
    return fields


# ---- drafts -------------------------------------------------------------------

DRAFT_SELECT = """
    SELECT d.id, d.name, d.parent_id, d.grade, d.setter_id, d.set_date, d.notes,
           d.saved_by, d.created_at, d.updated_at,
           parent.name AS parent_name, setter.name AS setter_name, saver.name AS saved_by_name
    FROM drafts d
    LEFT JOIN routes parent ON parent.id = d.parent_id
    LEFT JOIN climbers setter ON setter.id = d.setter_id
    LEFT JOIN climbers saver ON saver.id = d.saved_by
"""


def serialize_drafts(conn, drafts):
    """Each draft with its holds, as [{hold_id, role}]."""
    by_id = {d["id"]: dict(d, holds=[]) for d in drafts}
    if by_id:
        for dh in conn.execute(
            "SELECT draft_id, hold_id, role FROM draft_holds WHERE draft_id IN (%s)" % db.in_clause(by_id),
            list(by_id),
        ):
            by_id[dh["draft_id"]]["holds"].append({"hold_id": dh["hold_id"], "role": dh["role"]})
    return list(by_id.values())


def get_draft_or_404(conn, draft_id):
    draft = db.row(conn.execute(DRAFT_SELECT + " WHERE d.id = ?", (draft_id,)))
    if draft is None:
        not_found("Draft not found")
    return serialize_drafts(conn, [draft])[0]


def draft_fields(conn, data):
    """A draft's fields from the Set boulder form. Unlike a route, its name
    and set date may still be blank."""
    if data.get("grade") not in GRADES:
        bad_request("Grade must be one of %s" % ", ".join(GRADES))
    parent_id = optional_int(data.get("parent_id"))
    if parent_id is not None:
        parent = get_route_or_404(conn, parent_id)
        # Variations always hang off the base problem.
        parent_id = parent["parent_id"] or parent["id"]
    return {
        "name": (data.get("name") or "").strip(),
        "parent_id": parent_id,
        "grade": data["grade"],
        "setter_id": require_climber(conn, optional_int(data.get("setter_id")), "setter_id"),
        "set_date": parse_date(data["set_date"], "Set date") if data.get("set_date") else None,
        "notes": (data.get("notes") or "").strip(),
        "saved_by": require_climber(conn, optional_int(data.get("saved_by")), "saved_by"),
    }


def write_draft_holds(conn, draft_id, holds, keep=()):
    clean = clean_holds(conn, holds, keep)
    conn.execute("DELETE FROM draft_holds WHERE draft_id = ?", (draft_id,))
    conn.executemany("INSERT INTO draft_holds (draft_id, hold_id, role) VALUES (?, ?, ?)",
                     [(draft_id, hold_id, role) for hold_id, role in clean])


def insert_draft(conn, fields, holds, keep=()):
    cols = list(fields)
    cur = conn.execute(
        "INSERT INTO drafts (%s) VALUES (%s)" % (",".join(cols), db.in_clause(cols)),
        [fields[c] for c in cols],
    )
    write_draft_holds(conn, cur.lastrowid, holds, keep)
    return cur.lastrowid


# ---- routes ---------------------------------------------------------------------


@bp.get("/api/routes")
def list_routes():
    conn = db.get_db()
    args = request.args
    me = optional_int(args.get("me"))
    legacy = args.get("legacy") in ("1", "true")
    where, params = [], {"me": me}

    q = (args.get("q") or "").strip()
    scope = args.get("scope") or "all"
    if q:
        params["q"] = "%" + q + "%"
        fields = {
            "name": ["r.name LIKE :q", "parent.name LIKE :q"],
            "setter": ["setter.name LIKE :q"],
            "fa": ["fa.name LIKE :q"],
        }
        if scope not in fields and scope != "all":
            bad_request("scope must be all, name, setter or fa")
        clauses = sum(fields.values(), []) if scope == "all" else fields[scope]
        where.append("(" + " OR ".join(clauses) + ")")

    grades = [g for g in (args.get("grade") or "").split(",") if g]
    if grades:
        if any(g not in GRADES for g in grades):
            bad_request("Unknown grade")
        params.update(("grade%d" % i, g) for i, g in enumerate(grades))
        where.append("r.grade IN (%s)" % ",".join(":grade%d" % i for i in range(len(grades))))

    hold_id = optional_int(args.get("hold_id"))
    if hold_id is not None:
        params["hold_id"] = hold_id
        where.append("EXISTS (SELECT 1 FROM route_holds WHERE route_id = r.id AND hold_id = :hold_id)")

    hide_sent_by = optional_int(args.get("hide_sent_by"))
    if hide_sent_by is not None:
        params["hide"] = hide_sent_by
        where.append("NOT EXISTS (SELECT 1 FROM sends WHERE route_id = r.id AND climber_id = :hide)")

    sort = args.get("sort") or "set_date"
    if sort not in SORT_KEYS:
        bad_request("sort must be one of %s" % ", ".join(SORT_KEYS))
    descending = (args.get("dir") or "desc") != "asc"

    all_routes = [decorate(r) for r in db.rows(conn.execute(ROUTE_SELECT + " ORDER BY r.id", params))]
    sql = ROUTE_SELECT + (" WHERE " + " AND ".join(where) if where else "")
    matched = {r["id"] for r in conn.execute(sql, params)}

    ids = [r["id"] for r in all_routes]
    holds_by_route = route_holds(conn, ids)
    removed_by_route = removed_holds(conn, ids)
    bases = {}
    for r in all_routes:
        r["holds"] = holds_by_route[r["id"]]
        r["removed_holds"] = removed_by_route[r["id"]]
        if r["parent_id"] is None:
            r.update(matched=r["id"] in matched, variations=[], variation_total=0,
                     impossible_total=0 if r["possible"] else 1, family_possible=r["possible"],
                     variation_sent=False)
            bases[r["id"]] = r
    for r in all_routes:
        if r["parent_id"] is not None and r["parent_id"] in bases:
            base = bases[r["parent_id"]]
            base["variation_total"] += 1
            base["family_possible"] = base["family_possible"] or r["possible"]
            # whether `me` has sent any variation, shown or filtered out
            base["variation_sent"] = base["variation_sent"] or r["sent_by_me"]
            if not r["possible"]:
                base["impossible_total"] += 1
            if r["id"] in matched:
                base["variations"].append(r)

    # A family is legacy once none of its climbs can be done any more.
    result = [b for b in bases.values()
              if b["family_possible"] != legacy and (b["matched"] or b["variations"])]
    # Variations are sorted within their family; a family is placed by its
    # base problem, or by its top matching variation when the base itself
    # is filtered out.
    for b in result:
        b["variations"] = sort_climbs(b["variations"], sort, descending)
    result = sort_climbs(result, sort, descending, climb=lambda b: b if b["matched"] else b["variations"][0])
    return jsonify(result)


@bp.get("/api/routes/<int:route_id>")
def get_route(route_id):
    conn = db.get_db()
    me = optional_int(request.args.get("me"))
    route = db.row(conn.execute(ROUTE_SELECT + " WHERE r.id = :id", {"me": me, "id": route_id}))
    if route is None:
        not_found("Route not found")
    decorate(route)
    route["holds"] = route_holds(conn, [route_id])[route_id]
    route["removed_holds"] = removed_holds(conn, [route_id])[route_id]

    base_id = route["parent_id"] or route["id"]
    route["family"] = [
        decorate(f) for f in db.rows(conn.execute(
            ROUTE_SELECT + " WHERE r.id = :base OR r.parent_id = :base ORDER BY r.parent_id IS NOT NULL, r.id",
            {"me": me, "base": base_id},
        ))
    ]
    route["legacy"] = not any(f["possible"] for f in route["family"])
    # One row per climber: the date of their first send. Repeats are not listed.
    route["ascents"] = db.rows(conn.execute(
        """
        SELECT c.id AS climber_id, c.name, MIN(s.sent_date) AS first_sent
        FROM sends s JOIN climbers c ON c.id = s.climber_id
        WHERE s.route_id = ?
        GROUP BY c.id
        ORDER BY first_sent, MIN(s.id)
        """,
        (route_id,),
    ))
    for a in route["ascents"]:
        a["is_fa"] = a["climber_id"] == route["fa_climber_id"]
    route["circuits"] = db.rows(conn.execute(
        """SELECT c.id, c.name FROM circuits c JOIN circuit_routes cr ON cr.circuit_id = c.id
           WHERE cr.route_id = ? ORDER BY c.name COLLATE NOCASE""",
        (route_id,),
    ))
    # Me on this climb, newest first: my tries and sends, with their notes.
    route["my_history"] = db.rows(conn.execute(
        """
        SELECT 'try' AS kind, id, tried_date AS date, note FROM tries WHERE route_id = :id AND climber_id = :me
        UNION ALL
        SELECT 'send', id, sent_date, comment FROM sends WHERE route_id = :id AND climber_id = :me
        ORDER BY date DESC, kind, id DESC
        """,
        {"id": route_id, "me": me},
    )) if me else []
    return jsonify(route)


@bp.post("/api/routes")
def create_route():
    conn = db.get_db()
    data = request.get_json(silent=True) or {}
    fields = route_fields(conn, data, partial=False)
    parent_id = optional_int(data.get("parent_id"))
    if parent_id is not None:
        parent = get_route_or_404(conn, parent_id)
        # Variations always hang off the base problem.
        fields["parent_id"] = parent["parent_id"] or parent["id"]
    if bool(fields.get("fa_climber_id")) != bool(fields.get("fa_date")):
        bad_request("First ascent needs both a climber and a date")
    cols = list(fields)
    cur = conn.execute(
        "INSERT INTO routes (%s) VALUES (%s)" % (",".join(cols), db.in_clause(cols)),
        [fields[c] for c in cols],
    )
    write_holds(conn, cur.lastrowid, data.get("holds") or [])
    # Publishing a draft: it goes once the climb is in (one already gone is fine).
    draft_id = optional_int(data.get("draft_id"))
    if draft_id is not None:
        conn.execute("DELETE FROM drafts WHERE id = ?", (draft_id,))
    conn.commit()
    return jsonify({"id": cur.lastrowid}), 201


@bp.put("/api/routes/<int:route_id>")
def update_route(route_id):
    conn = db.get_db()
    route = get_route_or_404(conn, route_id)
    data = request.get_json(silent=True) or {}
    fields = route_fields(conn, data, partial=True)
    merged = dict(route, **fields)
    if bool(merged["fa_climber_id"]) != bool(merged["fa_date"]):
        bad_request("First ascent needs both a climber and a date")
    if fields:
        conn.execute(
            "UPDATE routes SET %s WHERE id = ?" % ", ".join("%s = ?" % c for c in fields),
            [fields[c] for c in fields] + [route_id],
        )
    if "holds" in data:
        current = {h["hold_id"] for h in route_holds(conn, [route_id])[route_id]}
        write_holds(conn, route_id, data["holds"], keep=current)
    conn.commit()
    return jsonify({"id": route_id})


@bp.delete("/api/routes/<int:route_id>")
def delete_route(route_id):
    conn = db.get_db()
    get_route_or_404(conn, route_id)
    conn.execute("DELETE FROM routes WHERE id = ?", (route_id,))
    conn.commit()
    return jsonify({"deleted": route_id})


@bp.post("/api/routes/<int:route_id>/draft")
def route_to_draft(route_id):
    """Takes a climb nobody has sent back to Drafts: the draft gets its
    fields and holds (removed ones included), and the climb goes, so it
    also leaves its circuits. A base problem with variations stays, as
    they would have nothing to hang off."""
    conn = db.get_db()
    route = get_route_or_404(conn, route_id)
    data = request.get_json(silent=True) or {}
    name = route["name"]
    if conn.execute("SELECT 1 FROM sends WHERE route_id = ?", (route_id,)).fetchone():
        bad_request("%s has been sent, so it can't go back to drafts" % name)
    if route["fa_date"]:
        bad_request("%s has a first ascent, so it can't go back to drafts" % name)
    variations = [r["name"] for r in conn.execute(
        "SELECT name FROM routes WHERE parent_id = ? ORDER BY id", (route_id,))]
    if variations:
        bad_request("%s has variations (%s), so it can't go back to drafts" % (name, ", ".join(variations)))
    if conn.execute("SELECT 1 FROM drafts WHERE parent_id = ?", (route_id,)).fetchone():
        bad_request("%s has a draft variation, so it can't go back to drafts" % name)
    holds = route_holds(conn, [route_id])[route_id]
    draft_id = insert_draft(conn, draft_fields(conn, dict(route, saved_by=data.get("saved_by"))),
                            holds, keep={h["hold_id"] for h in holds})
    conn.execute("DELETE FROM routes WHERE id = ?", (route_id,))
    conn.commit()
    return jsonify(get_draft_or_404(conn, draft_id)), 201


# ---- drafts ---------------------------------------------------------------------


@bp.get("/api/drafts")
def list_drafts():
    conn = db.get_db()
    drafts = db.rows(conn.execute(DRAFT_SELECT + " ORDER BY d.updated_at DESC, d.id DESC"))
    return jsonify(serialize_drafts(conn, drafts))


@bp.get("/api/drafts/<int:draft_id>")
def get_draft(draft_id):
    return jsonify(get_draft_or_404(db.get_db(), draft_id))


@bp.post("/api/drafts")
def create_draft():
    conn = db.get_db()
    data = request.get_json(silent=True) or {}
    draft_id = insert_draft(conn, draft_fields(conn, data), data.get("holds") or [])
    conn.commit()
    return jsonify(get_draft_or_404(conn, draft_id)), 201


@bp.put("/api/drafts/<int:draft_id>")
def update_draft(draft_id):
    conn = db.get_db()
    draft = get_draft_or_404(conn, draft_id)
    data = request.get_json(silent=True) or {}
    fields = draft_fields(conn, data)
    conn.execute(
        "UPDATE drafts SET %s, updated_at = datetime('now', 'localtime') WHERE id = ?"
        % ", ".join("%s = ?" % c for c in fields),
        [fields[c] for c in fields] + [draft_id],
    )
    write_draft_holds(conn, draft_id, data.get("holds") or [], keep={h["hold_id"] for h in draft["holds"]})
    conn.commit()
    return jsonify(get_draft_or_404(conn, draft_id))


@bp.delete("/api/drafts/<int:draft_id>")
def delete_draft(draft_id):
    conn = db.get_db()
    get_draft_or_404(conn, draft_id)
    conn.execute("DELETE FROM drafts WHERE id = ?", (draft_id,))
    conn.commit()
    return jsonify({"deleted": draft_id})
