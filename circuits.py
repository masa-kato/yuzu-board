"""Circuits (schema.sql: circuits, circuit_routes): named, ordered playlists
of climbs, shared by everyone. A climb that can no longer be done stays in
the circuits it was in, but can't be added to more. Endpoints that return a
circuit take ?me= so "sent by me" is filled in."""

from flask import Blueprint, jsonify, request

import db
from climbs import ROUTE_SELECT, decorate, removed_holds, route_holds
from helpers import bad_request, not_found, optional_int, require_climber

bp = Blueprint("circuits", __name__)

CIRCUIT_NAME_MAX = 80   # as CIRCUIT_NAME_MAX in views/shared.js

CIRCUIT_SELECT = """
    SELECT c.id, c.name, c.created_by, creator.name AS creator_name, c.created_at
    FROM circuits c
    LEFT JOIN climbers creator ON creator.id = c.created_by
"""


def get_circuit_or_404(conn, circuit_id):
    circuit = db.row(conn.execute(CIRCUIT_SELECT + " WHERE c.id = ?", (circuit_id,)))
    if circuit is None:
        not_found("Circuit not found")
    return circuit


def circuit_name(conn, value, exclude_id=None):
    name = " ".join((value or "").split())
    if not name:
        bad_request("Circuit name is required")
    if len(name) > CIRCUIT_NAME_MAX:
        bad_request("Circuit names can be at most %d characters" % CIRCUIT_NAME_MAX)
    if db.row(conn.execute("SELECT 1 FROM circuits WHERE name = ? AND id IS NOT ?", (name, exclude_id))):
        bad_request("Another circuit is already called %s" % name)
    return name


def circuit_route_ids(conn, raw, keep=()):
    """Validate a list of climbs for a circuit: duplicates are dropped and the
    order kept. Climbs that are no longer possible are only accepted if they
    were already in the circuit (`keep`)."""
    if not isinstance(raw, list):
        bad_request("route_ids must be a list")
    ids = []
    for value in raw:
        route_id = optional_int(value)
        if route_id is not None and route_id not in ids:
            ids.append(route_id)
    if not ids:
        return ids
    known = {r["id"] for r in conn.execute("SELECT id FROM routes WHERE id IN (%s)" % db.in_clause(ids), ids)}
    if len(known) != len(ids):
        bad_request("Circuit refers to an unknown climb")
    for names in removed_holds(conn, [i for i in ids if i not in keep]).values():
        if names:
            bad_request("That climb is no longer possible — it uses a removed hold (%s)" % ", ".join(names))
    return ids


def write_circuit_routes(conn, circuit_id, route_ids):
    conn.execute("DELETE FROM circuit_routes WHERE circuit_id = ?", (circuit_id,))
    conn.executemany(
        "INSERT INTO circuit_routes (circuit_id, route_id, position) VALUES (?, ?, ?)",
        [(circuit_id, route_id, i) for i, route_id in enumerate(route_ids)],
    )


def circuit_climbs(conn, circuit_ids, me):
    """{circuit_id: [climb, ...]} in circuit order. Each climb is shaped like a
    row of the climb list, holds and removed holds included."""
    result = {cid: [] for cid in circuit_ids}
    if not circuit_ids:
        return result
    members = db.rows(conn.execute(
        "SELECT circuit_id, route_id FROM circuit_routes WHERE circuit_id IN (%s) ORDER BY circuit_id, position"
        % db.in_clause(circuit_ids),
        list(circuit_ids),
    ))
    route_ids = sorted({m["route_id"] for m in members})
    if not route_ids:
        return result
    # ROUTE_SELECT takes named parameters, so the ids are named too.
    params = {"r%d" % i: route_id for i, route_id in enumerate(route_ids)}
    params["me"] = me
    routes = {r["id"]: decorate(r) for r in db.rows(conn.execute(
        ROUTE_SELECT + " WHERE r.id IN (%s)" % ",".join(":r%d" % i for i in range(len(route_ids))), params,
    ))}
    holds_by_route = route_holds(conn, route_ids)
    removed_by_route = removed_holds(conn, route_ids)
    for r in routes.values():
        r["holds"] = holds_by_route[r["id"]]
        r["removed_holds"] = removed_by_route[r["id"]]
    for m in members:
        result[m["circuit_id"]].append(routes[m["route_id"]])
    return result


def summarize_circuit(circuit, climbs):
    circuit.update(
        route_count=len(climbs),
        possible_count=sum(1 for c in climbs if c["possible"]),
        sent_count=sum(1 for c in climbs if c["sent_by_me"]),
        grades=[c["grade"] for c in climbs],
    )
    return circuit


def circuit_detail(conn, circuit_id, me):
    circuit = get_circuit_or_404(conn, circuit_id)
    climbs = circuit_climbs(conn, [circuit_id], me)[circuit_id]
    summarize_circuit(circuit, climbs)
    circuit["routes"] = climbs
    return circuit


def me_arg():
    return optional_int(request.args.get("me"))


@bp.get("/api/circuits")
def list_circuits():
    conn = db.get_db()
    circuits = db.rows(conn.execute(CIRCUIT_SELECT + " ORDER BY c.created_at DESC, c.id DESC"))
    climbs = circuit_climbs(conn, [c["id"] for c in circuits], me_arg())
    return jsonify([summarize_circuit(c, climbs[c["id"]]) for c in circuits])


@bp.post("/api/circuits")
def create_circuit():
    conn = db.get_db()
    data = request.get_json(silent=True) or {}
    name = circuit_name(conn, data.get("name"))
    created_by = require_climber(conn, optional_int(data.get("created_by")), "created_by")
    route_ids = circuit_route_ids(conn, data.get("route_ids") or [])
    cur = conn.execute("INSERT INTO circuits (name, created_by) VALUES (?, ?)", (name, created_by))
    write_circuit_routes(conn, cur.lastrowid, route_ids)
    conn.commit()
    return jsonify(circuit_detail(conn, cur.lastrowid, me_arg())), 201


@bp.get("/api/circuits/<int:circuit_id>")
def get_circuit(circuit_id):
    return jsonify(circuit_detail(db.get_db(), circuit_id, me_arg()))


@bp.put("/api/circuits/<int:circuit_id>")
def update_circuit(circuit_id):
    """Rename, and/or replace the climbs (reorder or remove) in one go."""
    conn = db.get_db()
    get_circuit_or_404(conn, circuit_id)
    data = request.get_json(silent=True) or {}
    if "name" in data:
        conn.execute("UPDATE circuits SET name = ? WHERE id = ?",
                     (circuit_name(conn, data["name"], circuit_id), circuit_id))
    if "route_ids" in data:
        current = {r["route_id"] for r in conn.execute(
            "SELECT route_id FROM circuit_routes WHERE circuit_id = ?", (circuit_id,))}
        write_circuit_routes(conn, circuit_id, circuit_route_ids(conn, data["route_ids"], keep=current))
    conn.commit()
    return jsonify(circuit_detail(conn, circuit_id, me_arg()))


@bp.post("/api/circuits/<int:circuit_id>/routes")
def add_to_circuit(circuit_id):
    conn = db.get_db()
    get_circuit_or_404(conn, circuit_id)
    route_id = optional_int((request.get_json(silent=True) or {}).get("route_id"))
    if route_id is None:
        bad_request("route_id is required")
    circuit_route_ids(conn, [route_id])
    if db.row(conn.execute("SELECT 1 FROM circuit_routes WHERE circuit_id = ? AND route_id = ?",
                           (circuit_id, route_id))):
        bad_request("That climb is already in this circuit")
    conn.execute(
        """INSERT INTO circuit_routes (circuit_id, route_id, position)
           SELECT ?, ?, COALESCE(MAX(position) + 1, 0) FROM circuit_routes WHERE circuit_id = ?""",
        (circuit_id, route_id, circuit_id),
    )
    conn.commit()
    return jsonify(circuit_detail(conn, circuit_id, me_arg())), 201


@bp.delete("/api/circuits/<int:circuit_id>/routes/<int:route_id>")
def remove_from_circuit(circuit_id, route_id):
    conn = db.get_db()
    get_circuit_or_404(conn, circuit_id)
    cur = conn.execute("DELETE FROM circuit_routes WHERE circuit_id = ? AND route_id = ?", (circuit_id, route_id))
    if not cur.rowcount:
        not_found("That climb isn't in this circuit")
    conn.commit()
    return jsonify(circuit_detail(conn, circuit_id, me_arg()))


@bp.delete("/api/circuits/<int:circuit_id>")
def delete_circuit(circuit_id):
    conn = db.get_db()
    get_circuit_or_404(conn, circuit_id)
    conn.execute("DELETE FROM circuits WHERE id = ?", (circuit_id,))
    conn.commit()
    return jsonify({"deleted": circuit_id})
