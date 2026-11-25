"""The wall (schema.sql: holds, colors, volumes): its holds, the shared list
of hold colors, and the volumes bolted to it. Removing a hold only marks it
removed, so the climbs that use it move to Legacy (climbs.py) and come back
if it's restored. The hold images themselves are hold_images.py's."""

import json
import math
import re

from flask import Blueprint, jsonify, request

import db
import geometry
import hold_images
import hold_names
from climbs import ROUTE_SELECT, decorate
from helpers import bad_request, not_found, parse_float

bp = Blueprint("holds", __name__)

COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
COLOR_NAME_MAX = 24
MAX_RECOLOR = 500   # holds in one bulk recolor
VOLUME_COLORS = ("black", "green")
VOLUME_PANELS = {"main", "foot", "left", "right"}   # not the ceiling
MAX_FACES = 50   # sub-polygons per volume

HOLD_SELECT = """SELECT id, name, x, y, tnut_col, tnut_row, image, size, rotation,
                        color, removed_at FROM holds"""
# The columns a hold form writes (hold_fields).
HOLD_FIELDS = ["name", "x", "y", "tnut_col", "tnut_row", "image", "size", "rotation", "color"]


# ---- holds --------------------------------------------------------------------


def serialize_hold(h, ppi=hold_images.BOARD_PPI[-1]):
    # A hold on a side panel or the ceiling has no t-nut, so no distance from one.
    offset = None
    if not geometry.tnut_free(h["x"], h["y"]):
        tx, ty = geometry.tnut_xy(h["tnut_col"], h["tnut_row"])
        offset = round(math.hypot(h["x"] - tx, h["y"] - ty), 2)
    return {
        "id": h["id"],
        "name": h["name"],
        "x": h["x"],
        "y": h["y"],
        "panel": geometry.panel_of(h["x"], h["y"]),
        "tnut_col": h["tnut_col"],
        "tnut_row": h["tnut_row"],
        "grid": geometry.hold_grid(h["x"], h["y"], h["tnut_col"], h["tnut_row"]),
        "offset": offset,
        "image_url": "/uploads/holds/%s" % h["image"] if h["image"] else None,
        "board_url": hold_images.board_url(h["image"], h["size"], ppi),
        "size": h["size"],
        "rotation": h["rotation"],
        "color": h["color"],
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
    values = dict(existing) if existing else {"size": 6.0, "rotation": 0.0, "color": None}
    if existing is None and ("x" not in form or "y" not in form):
        bad_request("x and y are required")
    if "x" in form:
        values["x"] = parse_float(form["x"], "x", geometry.MIN_X, geometry.MAX_X)
    if "y" in form:
        values["y"] = parse_float(form["y"], "y", geometry.MIN_Y, geometry.TOTAL_HEIGHT)
    if "size" in form:
        values["size"] = parse_float(form["size"], "Size", 0.5, 36)
    if "rotation" in form:
        values["rotation"] = parse_float(form["rotation"], "Rotation", -360, 360)
    if "color" in form:
        values["color"] = parse_color(form["color"])

    x, y = values["x"], values["y"]
    panel = geometry.panel_of(x, y)
    if panel is None:
        bad_request("Holds must sit on the main board, the footboard, a side panel or the ceiling")
    if panel in geometry.SIDE_LETTERS:
        # No t-nuts on a side panel: the panel's letter instead.
        values["tnut_col"] = values["tnut_row"] = None
        where = "it's on the %s" % geometry.SIDE_NAMES[panel].lower()
    elif panel == "ceiling":
        # Nor on the ceiling, but the columns carry on across it.
        values["tnut_col"] = values["tnut_row"] = None
        where = "it's in column %s on the ceiling" % geometry.col_label(geometry.nearest_tnut(x, y)[0])
    else:
        values["tnut_col"], values["tnut_row"], _ = geometry.nearest_tnut(x, y)
        where = "its nearest t-nut is %s" % geometry.tnut_label(values["tnut_col"], values["tnut_row"])
    letter = geometry.hold_letter(x, y)
    taken = taken_names(conn, existing and existing["id"])
    name = (form.get("name") if "name" in form else values.get("name")) or ""
    name = " ".join(name.split())
    if not name:
        name = hold_names.suggest_name(taken, letter)
    if not hold_names.starts_with_letter(name, letter):
        bad_request("Hold name must start with %s — %s" % (letter, where))
    if name.lower() in taken:
        bad_request("A removed hold is already called %s. Delete it permanently to reuse the name" % name
                    if taken[name.lower()] else "Another hold is already called %s" % name)
    values["name"] = name
    return values


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


@bp.get("/api/board")
def board():
    return jsonify(geometry.board_spec())


@bp.get("/api/hold-names")
def hold_name_list():
    return jsonify(hold_names.NOUNS)


@bp.get("/api/holds")
def list_holds():
    # ?ppi= sizes the board images for the screen asking (hold_images.BOARD_PPI).
    ppi = hold_images.board_ppi(request.args.get("ppi"))
    return jsonify([serialize_hold(h, ppi) for h in db.rows(db.get_db().execute(HOLD_SELECT + " ORDER BY id"))])


@bp.post("/api/holds")
def create_hold():
    conn = db.get_db()
    upload = request.files.get("image")
    if upload is None:
        bad_request("Choose a PNG image of the hold")
    data = hold_images.read_png(upload)
    values = hold_fields(conn, request.form)
    values["image"] = hold_images.store_png(data)
    cur = conn.execute(
        "INSERT INTO holds (%s) VALUES (%s)" % (",".join(HOLD_FIELDS), db.in_clause(HOLD_FIELDS)),
        [values[c] for c in HOLD_FIELDS],
    )
    conn.commit()
    return jsonify(serialize_hold(get_hold_or_404(conn, cur.lastrowid))), 201


@bp.put("/api/holds/<int:hold_id>")
def update_hold(hold_id):
    conn = db.get_db()
    existing = get_hold_or_404(conn, hold_id)
    form = request.form if request.form or request.files else (request.get_json(silent=True) or {})
    upload = request.files.get("image")
    data = hold_images.read_png(upload) if upload else None
    values = hold_fields(conn, form, existing)
    old_image = existing["image"]
    if data is not None:
        values["image"] = hold_images.store_png(data)
    conn.execute(
        "UPDATE holds SET %s WHERE id = ?" % ", ".join("%s = ?" % c for c in HOLD_FIELDS),
        [values[c] for c in HOLD_FIELDS] + [hold_id],
    )
    conn.commit()
    if data is not None and old_image:
        hold_images.remove_image(old_image)
    return jsonify(serialize_hold(get_hold_or_404(conn, hold_id)))


@bp.get("/api/holds/<int:hold_id>/impact")
def impact(hold_id):
    conn = db.get_db()
    get_hold_or_404(conn, hold_id)
    return jsonify(hold_impact(conn, hold_id))


@bp.delete("/api/holds/<int:hold_id>")
def remove_hold(hold_id):
    conn = db.get_db()
    hold = get_hold_or_404(conn, hold_id)
    if hold["removed_at"]:
        bad_request("%s has already been removed" % hold["name"])
    result = hold_impact(conn, hold_id)
    conn.execute("UPDATE holds SET removed_at = datetime('now') WHERE id = ?", (hold_id,))
    conn.commit()
    return jsonify(result)


@bp.post("/api/holds/<int:hold_id>/restore")
def restore_hold(hold_id):
    conn = db.get_db()
    get_hold_or_404(conn, hold_id)
    conn.execute("UPDATE holds SET removed_at = NULL WHERE id = ?", (hold_id,))
    conn.commit()
    return jsonify(serialize_hold(get_hold_or_404(conn, hold_id)))


@bp.delete("/api/holds/<int:hold_id>/permanent")
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
        hold_images.remove_image(image)
    return jsonify({"deleted": hold_id})


@bp.put("/api/holds/color")
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
        "SELECT id, removed_at FROM holds WHERE id IN (%s)" % db.in_clause(ids), ids)}
    if len(found) != len(ids):
        bad_request("Some of those holds don't exist")
    if any(found.values()):
        bad_request("Removed holds can't be recolored")
    conn.execute("UPDATE holds SET color = ? WHERE id IN (%s)" % db.in_clause(ids), [color] + ids)
    conn.commit()
    rows = db.rows(conn.execute(HOLD_SELECT + " WHERE id IN (%s) ORDER BY id" % db.in_clause(ids), ids))
    return jsonify([serialize_hold(h) for h in rows])


# ---- colors -------------------------------------------------------------------


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


@bp.get("/api/colors")
def list_colors():
    conn = db.get_db()
    rows = db.rows(conn.execute("SELECT * FROM colors ORDER BY position, id"))
    return jsonify([serialize_color(conn, c) for c in rows])


@bp.post("/api/colors")
def create_color():
    conn = db.get_db()
    values = color_values(conn, request.get_json(silent=True) or {})
    position = conn.execute("SELECT COALESCE(MAX(position) + 1, 0) FROM colors").fetchone()[0]
    cur = conn.execute("INSERT INTO colors (name, hex, position) VALUES (?, ?, ?)",
                       (values["name"], values["hex"], position))
    conn.commit()
    return jsonify(serialize_color(conn, get_color_or_404(conn, cur.lastrowid))), 201


@bp.put("/api/colors/<int:color_id>")
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


@bp.delete("/api/colors/<int:color_id>")
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


# ---- volumes ------------------------------------------------------------------


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
    if not panels <= VOLUME_PANELS:
        bad_request("Every corner must be on the main board, the footboard or a side panel")
    if len(panels) > 1:
        bad_request("A volume can't span the gap between two panels")
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


@bp.get("/api/volumes")
def list_volumes():
    rows = db.rows(db.get_db().execute("SELECT * FROM volumes ORDER BY id"))
    return jsonify([serialize_volume(v) for v in rows])


@bp.post("/api/volumes")
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


@bp.put("/api/volumes/<int:volume_id>")
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


@bp.delete("/api/volumes/<int:volume_id>")
def delete_volume(volume_id):
    conn = db.get_db()
    get_volume_or_404(conn, volume_id)
    conn.execute("DELETE FROM volumes WHERE id = ?", (volume_id,))
    conn.commit()
    return jsonify({"deleted": volume_id})
