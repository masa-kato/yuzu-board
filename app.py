import argparse
import datetime
import json
import math
import os
import re
import uuid

from flask import Flask, abort, current_app, jsonify, request, send_from_directory

import db
import geometry
import hold_names

GRADES = ("easy", "medium", "hard", "project")
ROLES = ("start", "hand", "foot", "finish")
# Sort keys for the climb list. `ascents` counts each climber once; `sends`
# counts every send, repeats included.
SORT_KEYS = {
    "set_date": lambda r: r["set_date"],
    "grade": lambda r: GRADES.index(r["grade"]),
    "fa_date": lambda r: r["fa_date"],
    "ascents": lambda r: r["ascent_count"],
    "sends": lambda r: r["send_count"],
}
HERE = os.path.dirname(os.path.abspath(__file__))
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
VOLUME_COLORS = ("black", "green")
MAX_FACES = 50   # sub-polygons per volume
CIRCUIT_NAME_MAX = 80


# --------------------------------------------------------------------------
# helpers


def error(message, status):
    response = jsonify({"error": message})
    response.status_code = status
    abort(response)


def bad_request(message):
    error(message, 400)


def not_found(what="Not found"):
    error(what, 404)


def parse_date(value, field):
    if not value:
        bad_request("%s is required" % field)
    try:
        return datetime.date.fromisoformat(str(value)).isoformat()
    except ValueError:
        bad_request("%s must be a date like 2026-10-22" % field)


def optional_int(value):
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        bad_request("Expected a number, got %r" % (value,))


def parse_float(value, field, lo, hi):
    try:
        number = float(value)
    except (TypeError, ValueError):
        bad_request("%s must be a number" % field)
    if math.isnan(number) or not lo <= number <= hi:
        bad_request("%s must be between %g and %g" % (field, lo, hi))
    return number


def display_name(name, parent_name):
    return "%s — %s" % (parent_name, name) if parent_name else name


def require_climber(conn, climber_id, field):
    if climber_id is None:
        return None
    if db.row(conn.execute("SELECT id FROM climbers WHERE id = ?", (climber_id,))) is None:
        bad_request("%s refers to an unknown climber" % field)
    return climber_id


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


def in_clause(ids):
    return ",".join("?" * len(ids))


def route_holds(conn, route_ids):
    """{route_id: [{hold_id, role}, ...]} for the given routes."""
    result = {rid: [] for rid in route_ids}
    if not route_ids:
        return result
    for rh in conn.execute(
        "SELECT route_id, hold_id, role FROM route_holds WHERE route_id IN (%s)" % in_clause(route_ids),
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
           WHERE h.removed_at IS NOT NULL AND rh.route_id IN (%s) ORDER BY h.name""" % in_clause(route_ids),
        list(route_ids),
    ):
        result[rh["route_id"]].append(rh["name"])
    return result


def write_holds(conn, route_id, holds, keep=()):
    """Replace a route's holds. Removed holds are only accepted if they were
    already on the route (`keep`), so legacy routes stay editable but nobody
    can set a new climb on a hold that is gone."""
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
        clean.append((route_id, hold_id, role))
    known = {h["id"]: h for h in db.rows(conn.execute("SELECT id, name, removed_at FROM holds"))}
    for _, hold_id, _ in clean:
        hold = known.get(hold_id)
        if hold is None:
            bad_request("Route uses an unknown hold")
        if hold["removed_at"] and hold_id not in keep:
            bad_request("Hold %s has been removed from the wall" % hold["name"])
    conn.execute("DELETE FROM route_holds WHERE route_id = ?", (route_id,))
    conn.executemany("INSERT INTO route_holds (route_id, hold_id, role) VALUES (?, ?, ?)", clean)


# --------------------------------------------------------------------------
# holds

HOLD_SELECT = """SELECT id, name, x, y, tnut_col, tnut_row, image, size, rotation,
                        color, color_opacity, removed_at FROM holds"""


def serialize_hold(h):
    tx, ty = geometry.tnut_xy(h["tnut_col"], h["tnut_row"])
    return {
        "id": h["id"],
        "name": h["name"],
        "x": h["x"],
        "y": h["y"],
        "tnut_col": h["tnut_col"],
        "tnut_row": h["tnut_row"],
        "grid": geometry.tnut_label(h["tnut_col"], h["tnut_row"]),
        "offset": round(math.hypot(h["x"] - tx, h["y"] - ty), 2),
        "image_url": "/uploads/holds/%s" % h["image"] if h["image"] else None,
        "size": h["size"],
        "rotation": h["rotation"],
        "color": h["color"],
        "color_opacity": h["color_opacity"],
        "removed": h["removed_at"] is not None,
    }


def parse_color(value):
    """A hold color as lowercase '#rrggbb', or None when blank (original colors)."""
    if value is None or value == "":
        return None
    if not isinstance(value, str) or not COLOR_RE.match(value.strip()):
        bad_request("Color must look like #a50606")
    return value.strip().lower()


def get_hold_or_404(conn, hold_id):
    hold = db.row(conn.execute(HOLD_SELECT + " WHERE id = ?", (hold_id,)))
    if hold is None:
        not_found("Hold not found")
    return hold


def taken_names(conn, exclude_id=None):
    """Every other hold's name, lowercased, mapped to whether that hold is
    removed. Names are unique across all holds, removed ones included, so a
    removed hold always comes back under its own name."""
    return {
        r["name"].lower(): bool(r["removed_at"]) for r in conn.execute(
            "SELECT name, removed_at FROM holds WHERE name IS NOT NULL AND id IS NOT ?", (exclude_id,)
        )
    }


def hold_fields(conn, form, existing=None):
    """Validate the placement/appearance fields of a hold form. Unspecified
    fields keep the existing hold's values (or defaults for a new hold)."""
    values = dict(existing) if existing else {"size": 6.0, "rotation": 0.0, "color": None, "color_opacity": 0.5}
    if existing is None and ("x" not in form or "y" not in form):
        bad_request("x and y are required")
    if "x" in form:
        values["x"] = parse_float(form["x"], "x", 0, geometry.WIDTH)
    if "y" in form:
        values["y"] = parse_float(form["y"], "y", 0, geometry.TOTAL_HEIGHT)
    if "size" in form:
        values["size"] = parse_float(form["size"], "Size", 0.5, 36)
    if "rotation" in form:
        values["rotation"] = parse_float(form["rotation"], "Rotation", -360, 360)
    if "color_opacity" in form:
        values["color_opacity"] = parse_float(form["color_opacity"], "Color opacity", 0, 1)
    if "color" in form:
        values["color"] = parse_color(form["color"])

    if not geometry.on_panel(values["x"], values["y"]):
        bad_request("Holds must sit on the main board or the footboard")
    col, row, _ = geometry.nearest_tnut(values["x"], values["y"])
    values["tnut_col"], values["tnut_row"] = col, row
    letter = geometry.name_letter(col)
    taken = taken_names(conn, existing and existing["id"])
    name = (form.get("name") if "name" in form else values.get("name")) or ""
    name = " ".join(name.split())
    if not name:
        name = hold_names.suggest_name(taken, letter)
    if not hold_names.starts_with_letter(name, letter):
        bad_request("Hold name must start with %s — its nearest t-nut is %s" % (letter, geometry.tnut_label(col, row)))
    if name.lower() in taken:
        bad_request("A removed hold is already called %s. Delete it permanently to reuse the name" % name
                    if taken[name.lower()] else "Another hold is already called %s" % name)
    values["name"] = name
    return values


def read_png(upload):
    data = upload.read()
    if not data.startswith(PNG_SIGNATURE):
        bad_request("Hold images must be PNG files")
    return data


def store_png(data):
    upload_dir = current_app.config["UPLOAD_DIR"]
    os.makedirs(upload_dir, exist_ok=True)
    filename = uuid.uuid4().hex + ".png"
    with open(os.path.join(upload_dir, filename), "wb") as f:
        f.write(data)
    return filename


def hold_impact(conn, hold_id):
    """What removing a hold does: every climb that uses it, plus which
    families would be retired to Legacy and which would only lose variants."""
    climbs = [decorate(c) for c in db.rows(conn.execute(
        ROUTE_SELECT + " JOIN route_holds rh ON rh.route_id = r.id WHERE rh.hold_id = :hold ORDER BY r.id",
        {"me": None, "hold": hold_id},
    ))]
    newly = {c["id"] for c in climbs if c["possible"]}
    retired, partial = [], []
    for base_id in sorted({c["parent_id"] or c["id"] for c in climbs if c["id"] in newly}):
        family = [decorate(f) for f in db.rows(conn.execute(
            ROUTE_SELECT + " WHERE r.id = :base OR r.parent_id = :base ORDER BY r.parent_id IS NOT NULL, r.id",
            {"me": None, "base": base_id},
        ))]
        still = [f["display_name"] for f in family if f["possible"] and f["id"] not in newly]
        lost = [f["display_name"] for f in family if f["id"] in newly]
        entry = {"route_id": base_id, "name": family[0]["name"], "newly_impossible": lost}
        if still:
            entry["still_possible"] = still
            partial.append(entry)
        else:
            retired.append(entry)
    return {
        "climbs": [{"id": c["id"], "display_name": c["display_name"], "possible": c["possible"]} for c in climbs],
        "retired": retired,
        "partial": partial,
    }


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


# --------------------------------------------------------------------------
# colors

COLOR_NAME_MAX = 24
MAX_RECOLOR = 500   # holds in one bulk recolor


def get_color_or_404(conn, color_id):
    color = db.row(conn.execute("SELECT * FROM colors WHERE id = ?", (color_id,)))
    if color is None:
        not_found("Color not found")
    return color


def color_holds(conn, hex_):
    """How many holds on the wall use this color."""
    return conn.execute("SELECT COUNT(*) FROM holds WHERE color = ? AND removed_at IS NULL", (hex_,)).fetchone()[0]


def serialize_color(conn, c):
    return {"id": c["id"], "name": c["name"], "hex": c["hex"], "holds": color_holds(conn, c["hex"])}


def color_values(conn, data, existing=None):
    """The validated name and hex of a new color, or of `existing` with the
    fields in `data` changed. Names and hexes are unique in the list."""
    values = {"name": existing["name"], "hex": existing["hex"]} if existing else {}
    if existing is None or "name" in data:
        name = data.get("name")
        name = name.strip() if isinstance(name, str) else ""
        if not name:
            bad_request("Give the color a name")
        if len(name) > COLOR_NAME_MAX:
            bad_request("Color names can be at most %d characters" % COLOR_NAME_MAX)
        values["name"] = name
    if existing is None or "hex" in data:
        values["hex"] = parse_color(data.get("hex"))
        if values["hex"] is None:
            bad_request("Color must look like #a50606")
    other = existing["id"] if existing else None
    clash = db.row(conn.execute("SELECT name FROM colors WHERE name = ? COLLATE NOCASE AND id IS NOT ?", (values["name"], other)))
    if clash:
        bad_request("There's already a color called %s" % clash["name"])
    clash = db.row(conn.execute("SELECT name FROM colors WHERE hex = ? AND id IS NOT ?", (values["hex"], other)))
    if clash:
        bad_request("%s is already %s" % (clash["name"], values["hex"].upper()))
    return values


# --------------------------------------------------------------------------
# volumes


def parse_corners(raw):
    """[x, y] pairs in wall inches, rounded to 0.01"."""
    points = []
    for corner in raw:
        if not isinstance(corner, (list, tuple)) or len(corner) != 2:
            bad_request("Each corner must be an [x, y] pair")
        x = parse_float(corner[0], "Corner x", -1e9, 1e9)
        y = parse_float(corner[1], "Corner y", -1e9, 1e9)
        points.append([round(x, 2), round(y, 2)])
    return points


def volume_points(raw):
    """Validate a volume outline: 3-100 [x, y] corners, all on one panel."""
    if not isinstance(raw, list) or not 3 <= len(raw) <= 100:
        bad_request("A volume needs between 3 and 100 corners")
    points = parse_corners(raw)
    panels = {geometry.panel_of(x, y) for x, y in points}
    if None in panels:
        bad_request("Every corner must be on the main board or the footboard")
    if len(panels) > 1:
        bad_request("A volume can't span the gap between the main board and the footboard")
    return points


def volume_faces(raw, points):
    """Validate a volume's faces: up to MAX_FACES sub-polygons of 3-100 corners
    each, on the same panel as the outline `points`."""
    if not isinstance(raw, list) or len(raw) > MAX_FACES:
        bad_request("faces must be a list of at most %d faces" % MAX_FACES)
    panel = geometry.panel_of(*points[0])
    faces = []
    for face in raw:
        if not isinstance(face, list) or not 3 <= len(face) <= 100:
            bad_request("Each face needs between 3 and 100 corners")
        corners = parse_corners(face)
        if any(geometry.panel_of(x, y) != panel for x, y in corners):
            bad_request("A face must stay on its volume's panel")
        faces.append(corners)
    return faces


def volume_color(value):
    if value not in VOLUME_COLORS:
        bad_request("Volume color must be black or green")
    return value


def serialize_volume(v):
    return {"id": v["id"], "points": json.loads(v["points"]), "color": v["color"], "faces": json.loads(v["faces"] or "[]")}


def get_volume_or_404(conn, volume_id):
    volume = db.row(conn.execute("SELECT * FROM volumes WHERE id = ?", (volume_id,)))
    if volume is None:
        not_found("Volume not found")
    return volume


# --------------------------------------------------------------------------
# circuits

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
    known = {r["id"] for r in conn.execute("SELECT id FROM routes WHERE id IN (%s)" % in_clause(ids), ids)}
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
        % in_clause(circuit_ids),
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


# --------------------------------------------------------------------------
# first-ascent bookkeeping


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


# --------------------------------------------------------------------------
# app


def create_app(db_path=None, upload_dir=None):
    app = Flask(__name__, static_folder=os.path.join(HERE, "static"), static_url_path="")
    app.config["DATABASE"] = db_path or db.DEFAULT_DB_PATH
    app.config["UPLOAD_DIR"] = upload_dir or os.path.join(HERE, "uploads", "holds")
    app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024
    app.json.ensure_ascii = False
    app.teardown_appcontext(db.close_db)

    conn = db.connect(app.config["DATABASE"])
    db.init_db(conn)
    conn.close()

    @app.errorhandler(413)
    def too_large(_exc):
        return jsonify({"error": "That image is too large (8 MB max)"}), 413

    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    @app.get("/uploads/holds/<path:filename>")
    def hold_image(filename):
        return send_from_directory(app.config["UPLOAD_DIR"], filename)

    # ---- board & holds ----------------------------------------------------

    @app.get("/api/board")
    def board():
        return jsonify(geometry.board_spec())

    @app.get("/api/hold-names")
    def hold_name_list():
        return jsonify(hold_names.NOUNS)

    @app.get("/api/holds")
    def holds():
        return jsonify([serialize_hold(h) for h in db.rows(db.get_db().execute(HOLD_SELECT + " ORDER BY id"))])

    @app.post("/api/holds")
    def create_hold():
        conn = db.get_db()
        upload = request.files.get("image")
        if upload is None:
            bad_request("Choose a PNG image of the hold")
        data = read_png(upload)
        values = hold_fields(conn, request.form)
        values["image"] = store_png(data)
        cols = ["name", "x", "y", "tnut_col", "tnut_row", "image", "size", "rotation", "color", "color_opacity"]
        cur = conn.execute(
            "INSERT INTO holds (%s) VALUES (%s)" % (",".join(cols), in_clause(cols)),
            [values[c] for c in cols],
        )
        conn.commit()
        return jsonify(serialize_hold(get_hold_or_404(conn, cur.lastrowid))), 201

    @app.put("/api/holds/<int:hold_id>")
    def update_hold(hold_id):
        conn = db.get_db()
        existing = get_hold_or_404(conn, hold_id)
        form = request.form if request.form or request.files else (request.get_json(silent=True) or {})
        upload = request.files.get("image")
        data = read_png(upload) if upload else None
        values = hold_fields(conn, form, existing)
        old_image = existing["image"]
        if data is not None:
            values["image"] = store_png(data)
        cols = ["name", "x", "y", "tnut_col", "tnut_row", "image", "size", "rotation", "color", "color_opacity"]
        conn.execute(
            "UPDATE holds SET %s WHERE id = ?" % ", ".join("%s = ?" % c for c in cols),
            [values[c] for c in cols] + [hold_id],
        )
        conn.commit()
        if data is not None and old_image:
            try:
                os.remove(os.path.join(app.config["UPLOAD_DIR"], old_image))
            except OSError:
                pass
        return jsonify(serialize_hold(get_hold_or_404(conn, hold_id)))

    @app.get("/api/holds/<int:hold_id>/impact")
    def impact(hold_id):
        conn = db.get_db()
        get_hold_or_404(conn, hold_id)
        return jsonify(hold_impact(conn, hold_id))

    @app.delete("/api/holds/<int:hold_id>")
    def remove_hold(hold_id):
        conn = db.get_db()
        hold = get_hold_or_404(conn, hold_id)
        if hold["removed_at"]:
            bad_request("%s has already been removed" % hold["name"])
        result = hold_impact(conn, hold_id)
        conn.execute("UPDATE holds SET removed_at = datetime('now') WHERE id = ?", (hold_id,))
        conn.commit()
        return jsonify(result)

    @app.post("/api/holds/<int:hold_id>/restore")
    def restore_hold(hold_id):
        conn = db.get_db()
        get_hold_or_404(conn, hold_id)
        conn.execute("UPDATE holds SET removed_at = NULL WHERE id = ?", (hold_id,))
        conn.commit()
        return jsonify(serialize_hold(get_hold_or_404(conn, hold_id)))

    @app.delete("/api/holds/<int:hold_id>/permanent")
    def delete_hold_permanently(hold_id):
        """Deletes a removed hold and its image for good. Refused while any
        climb (legacy ones included) still uses it, since deleting it would
        silently drop it from those climbs."""
        conn = db.get_db()
        hold = get_hold_or_404(conn, hold_id)
        if not hold["removed_at"]:
            bad_request("Remove %s from the wall first" % hold["name"])
        climbs = hold_impact(conn, hold_id)["climbs"]
        if climbs:
            bad_request("%s is still used by %s: %s. Delete those climbs or swap the hold out first" % (
                hold["name"], "1 climb" if len(climbs) == 1 else "%d climbs" % len(climbs),
                ", ".join(c["display_name"] for c in climbs)))
        image = hold["image"]
        conn.execute("DELETE FROM holds WHERE id = ?", (hold_id,))
        conn.commit()
        if image and not conn.execute("SELECT 1 FROM holds WHERE image = ?", (image,)).fetchone():
            try:
                os.remove(os.path.join(app.config["UPLOAD_DIR"], image))
            except OSError:
                pass
        return jsonify({"deleted": hold_id})

    @app.put("/api/holds/color")
    def recolor_holds():
        """Gives every hold in `hold_ids` the same color (null = original colors)."""
        conn = db.get_db()
        data = request.get_json(silent=True) or {}
        ids = data.get("hold_ids")
        if (not isinstance(ids, list) or not 1 <= len(ids) <= MAX_RECOLOR
                or not all(isinstance(i, int) and not isinstance(i, bool) for i in ids)):
            bad_request("Choose between 1 and %d holds" % MAX_RECOLOR)
        if "color" not in data:
            bad_request("Choose a color")
        color = parse_color(data["color"])
        ids = sorted(set(ids))
        found = {r["id"]: r["removed_at"] for r in conn.execute(
            "SELECT id, removed_at FROM holds WHERE id IN (%s)" % in_clause(ids), ids)}
        if len(found) != len(ids):
            bad_request("Some of those holds don't exist")
        if any(found.values()):
            bad_request("Removed holds can't be recolored")
        conn.execute("UPDATE holds SET color = ? WHERE id IN (%s)" % in_clause(ids), [color] + ids)
        conn.commit()
        rows = db.rows(conn.execute(HOLD_SELECT + " WHERE id IN (%s) ORDER BY id" % in_clause(ids), ids))
        return jsonify([serialize_hold(h) for h in rows])

    # ---- colors -----------------------------------------------------------

    @app.get("/api/colors")
    def list_colors():
        conn = db.get_db()
        rows = db.rows(conn.execute("SELECT * FROM colors ORDER BY position, id"))
        return jsonify([serialize_color(conn, c) for c in rows])

    @app.post("/api/colors")
    def create_color():
        conn = db.get_db()
        values = color_values(conn, request.get_json(silent=True) or {})
        position = conn.execute("SELECT COALESCE(MAX(position) + 1, 0) FROM colors").fetchone()[0]
        cur = conn.execute("INSERT INTO colors (name, hex, position) VALUES (?, ?, ?)",
                           (values["name"], values["hex"], position))
        conn.commit()
        return jsonify(serialize_color(conn, get_color_or_404(conn, cur.lastrowid))), 201

    @app.put("/api/colors/<int:color_id>")
    def update_color(color_id):
        conn = db.get_db()
        color = get_color_or_404(conn, color_id)
        values = color_values(conn, request.get_json(silent=True) or {}, color)
        recolored = 0
        if values["hex"] != color["hex"]:
            # Holds store the hex, so the holds in this color follow it; removed
            # ones too, so they match again if restored. `recolored` counts the
            # ones on the wall.
            recolored = color_holds(conn, color["hex"])
            conn.execute("UPDATE holds SET color = ? WHERE color = ?", (values["hex"], color["hex"]))
        conn.execute("UPDATE colors SET name = ?, hex = ? WHERE id = ?", (values["name"], values["hex"], color_id))
        conn.commit()
        return jsonify({"color": serialize_color(conn, get_color_or_404(conn, color_id)), "recolored": recolored})

    @app.delete("/api/colors/<int:color_id>")
    def delete_color(color_id):
        conn = db.get_db()
        color = get_color_or_404(conn, color_id)
        used = color_holds(conn, color["hex"])
        if used:
            bad_request("%s is used by %s. Recolor %s first" % (
                color["name"], "1 hold" if used == 1 else "%d holds" % used, "it" if used == 1 else "them"))
        conn.execute("DELETE FROM colors WHERE id = ?", (color_id,))
        conn.commit()
        return jsonify({"deleted": color_id})

    # ---- volumes ----------------------------------------------------------

    @app.get("/api/volumes")
    def list_volumes():
        rows = db.rows(db.get_db().execute("SELECT * FROM volumes ORDER BY id"))
        return jsonify([serialize_volume(v) for v in rows])

    @app.post("/api/volumes")
    def create_volume():
        conn = db.get_db()
        data = request.get_json(silent=True) or {}
        points = volume_points(data.get("points"))
        color = volume_color(data.get("color"))
        faces = volume_faces(data.get("faces") or [], points)
        cur = conn.execute("INSERT INTO volumes (points, color, faces) VALUES (?, ?, ?)",
                           (json.dumps(points), color, json.dumps(faces)))
        conn.commit()
        return jsonify(serialize_volume(get_volume_or_404(conn, cur.lastrowid))), 201

    @app.put("/api/volumes/<int:volume_id>")
    def update_volume(volume_id):
        conn = db.get_db()
        volume = get_volume_or_404(conn, volume_id)
        data = request.get_json(silent=True) or {}
        points = volume_points(data["points"]) if "points" in data else json.loads(volume["points"])
        color = volume_color(data["color"]) if "color" in data else volume["color"]
        # Faces not sent are kept, but still checked against the (possibly new) outline.
        faces = volume_faces(data["faces"] if "faces" in data else json.loads(volume["faces"] or "[]"), points)
        conn.execute("UPDATE volumes SET points = ?, color = ?, faces = ? WHERE id = ?",
                     (json.dumps(points), color, json.dumps(faces), volume_id))
        conn.commit()
        return jsonify(serialize_volume(get_volume_or_404(conn, volume_id)))

    @app.delete("/api/volumes/<int:volume_id>")
    def delete_volume(volume_id):
        conn = db.get_db()
        get_volume_or_404(conn, volume_id)
        conn.execute("DELETE FROM volumes WHERE id = ?", (volume_id,))
        conn.commit()
        return jsonify({"deleted": volume_id})

    # ---- climbers ---------------------------------------------------------

    @app.get("/api/climbers")
    def list_climbers():
        return jsonify(db.rows(db.get_db().execute("SELECT id, name FROM climbers ORDER BY name COLLATE NOCASE")))

    @app.post("/api/climbers")
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

    @app.get("/api/climbers/<int:climber_id>/sends")
    def logbook(climber_id):
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
        return jsonify({
            "climber": climber,
            "sends": sends,
            "summary": {
                "total_sends": len(sends),
                "unique_climbs": len({s["route_id"] for s in sends}),
                "first_ascents": sum(1 for s in sends if s["is_fa"]),
            },
        })

    # ---- routes -----------------------------------------------------------

    @app.get("/api/routes")
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
            where.append("r.grade IN (%s)" % ",".join("'%s'" % g for g in grades))

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
                         impossible_total=0 if r["possible"] else 1, family_possible=r["possible"])
                bases[r["id"]] = r
        for r in all_routes:
            if r["parent_id"] is not None and r["parent_id"] in bases:
                base = bases[r["parent_id"]]
                base["variation_total"] += 1
                base["family_possible"] = base["family_possible"] or r["possible"]
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

    @app.get("/api/routes/<int:route_id>")
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
        return jsonify(route)

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

    @app.post("/api/routes")
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
            "INSERT INTO routes (%s) VALUES (%s)" % (",".join(cols), in_clause(cols)),
            [fields[c] for c in cols],
        )
        write_holds(conn, cur.lastrowid, data.get("holds") or [])
        conn.commit()
        return jsonify({"id": cur.lastrowid}), 201

    @app.put("/api/routes/<int:route_id>")
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

    @app.delete("/api/routes/<int:route_id>")
    def delete_route(route_id):
        conn = db.get_db()
        get_route_or_404(conn, route_id)
        conn.execute("DELETE FROM routes WHERE id = ?", (route_id,))
        conn.commit()
        return jsonify({"deleted": route_id})

    # ---- sends ------------------------------------------------------------

    @app.post("/api/sends")
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

    def get_send_or_404(conn, send_id):
        send = db.row(conn.execute("SELECT * FROM sends WHERE id = ?", (send_id,)))
        if send is None:
            not_found("Send not found")
        return send

    @app.put("/api/sends/<int:send_id>")
    def update_send(send_id):
        conn = db.get_db()
        send = get_send_or_404(conn, send_id)
        route = get_route_or_404(conn, send["route_id"])
        data = request.get_json(silent=True) or {}
        updated = dict(send)
        if "sent_date" in data:
            updated["sent_date"] = parse_date(data["sent_date"], "Send date")
        if "comment" in data:
            updated["comment"] = (data.get("comment") or "").strip()
        if "climber_id" in data:
            updated["climber_id"] = require_climber(conn, optional_int(data["climber_id"]), "climber_id")
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

    @app.delete("/api/sends/<int:send_id>")
    def delete_send(send_id):
        conn = db.get_db()
        send = get_send_or_404(conn, send_id)
        route = get_route_or_404(conn, send["route_id"])
        conn.execute("DELETE FROM sends WHERE id = ?", (send_id,))
        if is_fa_send(route, send):
            recompute_fa(conn, route["id"])
        conn.commit()
        return jsonify({"deleted": send_id})

    # ---- circuits ---------------------------------------------------------
    # Endpoints that return a circuit take ?me= so "sent by me" is filled in.

    def me_arg():
        return optional_int(request.args.get("me"))

    @app.get("/api/circuits")
    def list_circuits():
        conn = db.get_db()
        circuits = db.rows(conn.execute(CIRCUIT_SELECT + " ORDER BY c.created_at DESC, c.id DESC"))
        climbs = circuit_climbs(conn, [c["id"] for c in circuits], me_arg())
        return jsonify([summarize_circuit(c, climbs[c["id"]]) for c in circuits])

    @app.post("/api/circuits")
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

    @app.get("/api/circuits/<int:circuit_id>")
    def get_circuit(circuit_id):
        return jsonify(circuit_detail(db.get_db(), circuit_id, me_arg()))

    @app.put("/api/circuits/<int:circuit_id>")
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

    @app.post("/api/circuits/<int:circuit_id>/routes")
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

    @app.delete("/api/circuits/<int:circuit_id>/routes/<int:route_id>")
    def remove_from_circuit(circuit_id, route_id):
        conn = db.get_db()
        get_circuit_or_404(conn, circuit_id)
        cur = conn.execute("DELETE FROM circuit_routes WHERE circuit_id = ? AND route_id = ?", (circuit_id, route_id))
        if not cur.rowcount:
            not_found("That climb isn't in this circuit")
        conn.commit()
        return jsonify(circuit_detail(conn, circuit_id, me_arg()))

    @app.delete("/api/circuits/<int:circuit_id>")
    def delete_circuit(circuit_id):
        conn = db.get_db()
        get_circuit_or_404(conn, circuit_id)
        conn.execute("DELETE FROM circuits WHERE id = ?", (circuit_id,))
        conn.commit()
        return jsonify({"deleted": circuit_id})

    return app


def main():
    parser = argparse.ArgumentParser(description="The Yuzu Board: a home bouldering wall route tracker")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=5050)
    parser.add_argument("--db", default=db.DEFAULT_DB_PATH)
    parser.add_argument("--uploads", help="folder for hold images (default: uploads/holds)")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    app = create_app(args.db, args.uploads)
    conn = db.connect(args.db)
    empty = conn.execute("SELECT COUNT(*) FROM holds").fetchone()[0] == 0
    conn.close()
    if empty:
        import seed
        seed.seed(args.db)
        print("Seeded demo holds, routes and sends.")
    app.run(host=args.host, port=args.port, debug=args.debug)


if __name__ == "__main__":
    main()
