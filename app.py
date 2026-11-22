import argparse
import getpass
import glob
import hashlib
import json
import math
import os
import re
import uuid

from flask import Flask, abort, current_app, jsonify, request, send_from_directory
from PIL import Image, ImageChops

import auth
import db
import fingers
import geometry
import hold_names
import outdoor
import workouts
from helpers import bad_request, not_found, optional_int, parse_date, parse_float, text

# Easiest first (sorting by grade goes by this order).
GRADES = ("warmup", "easy", "medium", "hard", "project")
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
STORED_PNG_RE = re.compile(r"^[0-9a-f]{32}\.png$")
# The board shows each hold image as a smaller copy, a number of pixels per
# inch of the hold's size. A screen asks for what it needs to stay sharp at its
# closest zoom (?ppi= on /api/holds) and gets the smallest of BOARD_PPI that
# covers it: a phone, which stops at 2.5×, about 24; a retina laptop at 6×
# about 62, so 64 (also the default).
BOARD_PPI = (24, 32, 48, 64)
BOARD_PX_STEP = 32
BOARD_PX_MIN, BOARD_PX_MAX = 96, 2048
BOARD_IMAGE_RE = re.compile(
    r"^([0-9a-f]{32})-(\d+)(?:-(s|o\d{1,2}(?:t[0-9a-f]{6}\d{1,3})?|t[0-9a-f]{6}\d{1,3}))?\.png$")
# Touch screens draw holds from ready-made variants of the board copy rather
# than SVG filters, which phones redraw slowly (board.js LIGHT): `o<b>` bakes
# in the white border, b pixels wide, and `t<rrggbb><percent>` the hold's
# color laid over it at that opacity (`-o5t1e3a8a75`, or either alone); `-s`
# is the hold's shape in black, for finding the bolt holes it covers.
BOARD_BORDER_MAX = 24
BOARD_BORDER_OPACITY = 0.9   # as BORDER_OPACITY in board.js
# Touch screens draw every hold on the wall as one picture (wall_picture),
# at one of PICTURE_PPI pixels per inch: sharp at their closest zoom.
PICTURE_PPI = (12, 16, 20)
PICTURE_BORDER_MAX = 16
PICTURE_KEEP = 8   # pictures kept on disk; older ones are deleted
WALL_PICTURE_RE = re.compile(r"^wall-[0-9a-f]{20}\.webp$")
# Image files never change: a new image gets a new name.
IMAGE_MAX_AGE = 365 * 24 * 3600
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
VOLUME_COLORS = ("black", "green")
VOLUME_PANELS = {"main", "foot"}   # not the side panels or the ceiling
MAX_FACES = 50   # sub-polygons per volume
CIRCUIT_NAME_MAX = 80


# --------------------------------------------------------------------------
# helpers (error, parse_date and the like are in helpers.py)


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


# --------------------------------------------------------------------------
# drafts

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
            "SELECT draft_id, hold_id, role FROM draft_holds WHERE draft_id IN (%s)" % in_clause(by_id),
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
        "INSERT INTO drafts (%s) VALUES (%s)" % (",".join(cols), in_clause(cols)),
        [fields[c] for c in cols],
    )
    write_draft_holds(conn, cur.lastrowid, holds, keep)
    return cur.lastrowid


# --------------------------------------------------------------------------
# holds

HOLD_SELECT = """SELECT id, name, x, y, tnut_col, tnut_row, image, size, rotation,
                        color, color_opacity, removed_at FROM holds"""


def serialize_hold(h, ppi=BOARD_PPI[-1]):
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
        "board_url": board_url(h["image"], h["size"], ppi),
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
        values["x"] = parse_float(form["x"], "x", geometry.MIN_X, geometry.MAX_X)
    if "y" in form:
        values["y"] = parse_float(form["y"], "y", geometry.MIN_Y, geometry.TOTAL_HEIGHT)
    if "size" in form:
        values["size"] = parse_float(form["size"], "Size", 0.5, 36)
    if "rotation" in form:
        values["rotation"] = parse_float(form["rotation"], "Rotation", -360, 360)
    if "color_opacity" in form:
        values["color_opacity"] = parse_float(form["color_opacity"], "Color opacity", 0, 1)
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


def board_ppi(asked):
    """The smallest of BOARD_PPI that covers what a screen asked for (the
    largest when it asks for more, or for nothing that reads as a number)."""
    try:
        asked = float(asked)
    except (TypeError, ValueError):
        return BOARD_PPI[-1]
    return next((ppi for ppi in BOARD_PPI if ppi >= asked), BOARD_PPI[-1])


def board_url(image, size, ppi=BOARD_PPI[-1]):
    """The URL of a hold image's copy for the board, `ppi` pixels per inch of
    the hold (see BOARD_PPI), or None when it has no image. The pixel size is
    part of the name, so resizing a hold asks for a new copy."""
    if not image or not STORED_PNG_RE.match(image):
        return None
    px = math.ceil(size * ppi / BOARD_PX_STEP) * BOARD_PX_STEP
    px = min(BOARD_PX_MAX, max(BOARD_PX_MIN, px))
    return "/uploads/holds/board/%s-%d.png" % (image[:-4], px)


def board_variant(im, variant, px):
    """One of the touch screens' ready-made looks (BOARD_IMAGE_RE) of a hold
    image. Each is exactly `px` on its longest side, as the board draws it
    that big; one with a border is then padded by it on every side."""
    w, h = im.size
    scale = px / max(w, h)
    im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.Resampling.LANCZOS)
    alpha = im.getchannel("A")
    if variant == "s":
        return Image.merge("RGBA", (*Image.new("RGB", im.size, (0, 0, 0)).split(), alpha))
    border, color, percent = re.fullmatch(r"(?:o(\d+))?(?:t([0-9a-f]{6})(\d+))?", variant).groups()
    if color:
        # The color over the hold, as the board's tint filter lays it on.
        rgb = tuple(int(color[i:i + 2], 16) for i in (0, 2, 4))
        im = Image.blend(im, Image.new("RGBA", im.size, rgb + (255,)), int(percent) / 100)
        im.putalpha(alpha)
    if not border:
        return im
    # The border: the shape grown by b pixels every way (the union of its copies
    # moved to each point of a disc's rim and inside it), white, under the image.
    b = int(border)
    padded = Image.new("L", (im.width + 2 * b, im.height + 2 * b), 0)
    grown = padded.copy()
    padded.paste(alpha, (b, b))
    for dx in range(-b, b + 1):
        for dy in range(-b, b + 1):
            if dx * dx + dy * dy <= b * b:
                grown = ImageChops.lighter(grown, ImageChops.offset(padded, dx, dy))
    out = Image.merge("RGBA", (*Image.new("RGB", grown.size, (255, 255, 255)).split(),
                               grown.point(lambda v: round(v * BOARD_BORDER_OPACITY))))
    out.alpha_composite(im, (b, b))
    return out


def make_board_image(source, target, px, variant=None):
    """Writes a copy of the PNG at `source` at most `px` on its longest side
    (never larger than the original), or one of its variants (board_variant)."""
    with Image.open(source) as im:
        im = im.convert("RGBA")
        if variant:
            im = board_variant(im, variant, px)
        else:
            im.thumbnail((px, px), Image.Resampling.LANCZOS)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        # Written aside first, so a request at the same moment never gets half a file.
        partial = "%s.%s.tmp" % (target, uuid.uuid4().hex)
        im.save(partial, "PNG")
    os.replace(partial, target)


def board_copy(upload_dir, stem, px, variant=None):
    """The path of a hold image's board copy (or variant), made if it's not
    there yet; None when the image itself is gone."""
    name = "%s-%d%s.png" % (stem, px, "-" + variant if variant else "")
    path = os.path.join(upload_dir, "board", name)
    if not os.path.exists(path):
        source = os.path.join(upload_dir, stem + ".png")
        if not os.path.exists(source):
            return None
        make_board_image(source, path, px, variant)
    return path


def wall_picture(conn, upload_dir, ppi, border, tint):
    """Every hold on the wall drawn into one picture, as touch screens show
    them (board.js LIGHT): each at its place, size and rotation, with its
    color laid over at `tint` percent and a white border `border` pixels
    wide. It covers the wall from (MIN_X, MIN_Y) to (MAX_X, TOTAL_HEIGHT) at
    `ppi` pixels per inch, stacked in id order as the board stacks them.
    Returns its file name and the indexes into geometry.bolt_holes() of the
    holes it covers. The name follows from the holds and the settings, so a
    picture is drawn once and an older one is never shown by mistake."""
    holds = db.rows(conn.execute(
        "SELECT id, image, x, y, size, rotation, color FROM holds"
        " WHERE removed_at IS NULL AND image IS NOT NULL ORDER BY id"))
    holds = [h for h in holds if STORED_PNG_RE.match(h["image"])]
    extent = (geometry.MIN_X, geometry.MIN_Y, geometry.MAX_X, geometry.TOTAL_HEIGHT)
    key = hashlib.sha1(json.dumps([holds, ppi, border, tint, extent]).encode()).hexdigest()[:20]
    board_dir = os.path.join(upload_dir, "board")
    name = "wall-%s.webp" % key
    path = os.path.join(board_dir, name)
    covers_path = path[:-5] + ".json"
    if os.path.exists(path) and os.path.exists(covers_path):
        with open(covers_path) as f:
            return name, json.load(f)

    width = round((geometry.MAX_X - geometry.MIN_X) * ppi)
    height = round((geometry.TOTAL_HEIGHT - geometry.MIN_Y) * ppi)
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for h in holds:
        px = max(1, round(h["size"] * ppi))
        # From a board copy at least that big, so the original is read once.
        copy_px = min(BOARD_PX_MAX, max(BOARD_PX_MIN, math.ceil(px / BOARD_PX_STEP) * BOARD_PX_STEP))
        copy = board_copy(upload_dir, h["image"][:-4], copy_px)
        if copy is None:
            continue
        variant = "o%d" % border
        if h["color"] and tint:
            variant += "t%s%d" % (h["color"][1:], tint)
        with Image.open(copy) as im:
            look = board_variant(im.convert("RGBA"), variant, px)
        # SVG turns a positive angle clockwise; Pillow turns it the other way.
        look = look.rotate(-h["rotation"], resample=Image.Resampling.BICUBIC, expand=True)
        left = round((h["x"] - geometry.MIN_X) * ppi - look.width / 2)
        top = round((h["y"] - geometry.MIN_Y) * ppi - look.height / 2)
        # Only the part on the picture (alpha_composite takes no negative offsets).
        crop = (max(0, -left), max(0, -top), min(look.width, width - left), min(look.height, height - top))
        if crop[0] < crop[2] and crop[1] < crop[3]:
            canvas.alpha_composite(look.crop(crop), (left + crop[0], top + crop[1]))

    alpha = canvas.getchannel("A")
    covered = []
    for i, (x, y) in enumerate(geometry.bolt_holes()):
        px, py = round((x - geometry.MIN_X) * ppi), round((y - geometry.MIN_Y) * ppi)
        if 0 <= px < width and 0 <= py < height and alpha.getpixel((px, py)) > 127:
            covered.append(i)

    os.makedirs(board_dir, exist_ok=True)
    # Written aside first, so a request at the same moment never gets half a file.
    partial = "%s.%s.tmp" % (path, uuid.uuid4().hex)
    canvas.save(partial, "WEBP", quality=85, method=4)
    os.replace(partial, path)
    partial = "%s.%s.tmp" % (covers_path, uuid.uuid4().hex)
    with open(partial, "w") as f:
        json.dump(covered, f)
    os.replace(partial, covers_path)

    # Keep only the newest few.
    pictures = sorted(glob.glob(os.path.join(board_dir, "wall-*.webp")), key=os.path.getmtime, reverse=True)
    for old in pictures[PICTURE_KEEP:]:
        for stale in (old, old[:-5] + ".json"):
            try:
                os.remove(stale)
            except OSError:
                pass
    return name, covered


def remove_image(filename):
    """Deletes an uploaded hold image and its copies for the board."""
    upload_dir = current_app.config["UPLOAD_DIR"]
    stem = os.path.splitext(filename)[0]
    paths = [os.path.join(upload_dir, filename)]
    paths += glob.glob(os.path.join(upload_dir, "board", glob.escape(stem) + "-*.png"))
    for path in paths:
        try:
            os.remove(path)
        except OSError:
            pass


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
    if not panels <= VOLUME_PANELS:
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
    auth.init_app(app, conn)
    conn.close()
    app.register_blueprint(outdoor.bp)
    app.register_blueprint(workouts.bp)
    app.register_blueprint(fingers.bp)

    @app.errorhandler(413)
    def too_large(_exc):
        return jsonify({"error": "That image is too large (8 MB max)"}), 413

    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    @app.get("/uploads/holds/<path:filename>")
    def hold_image(filename):
        return send_from_directory(app.config["UPLOAD_DIR"], filename, max_age=IMAGE_MAX_AGE)

    @app.get("/uploads/holds/board/<name>")
    def board_image(name):
        """A hold image's copy for the board, made the first time it's asked
        for; or a picture of the whole wall's holds (made by /api/holds/picture)."""
        board_dir = os.path.join(app.config["UPLOAD_DIR"], "board")
        if WALL_PICTURE_RE.match(name):
            if not os.path.exists(os.path.join(board_dir, name)):
                abort(404)
            return send_from_directory(board_dir, name, max_age=IMAGE_MAX_AGE, mimetype="image/webp")
        match = BOARD_IMAGE_RE.match(name)
        px = int(match.group(2)) if match else 0
        if px % BOARD_PX_STEP or not BOARD_PX_MIN <= px <= BOARD_PX_MAX:
            abort(404)
        variant = match.group(3)
        if variant and variant != "s":
            border, percent = re.fullmatch(r"(?:o(\d+))?(?:t[0-9a-f]{6}(\d+))?", variant).groups()
            if border and not 1 <= int(border) <= BOARD_BORDER_MAX or percent and int(percent) > 100:
                abort(404)
        if board_copy(app.config["UPLOAD_DIR"], match.group(1), px, variant) is None:
            abort(404)
        return send_from_directory(board_dir, name, max_age=IMAGE_MAX_AGE)

    @app.get("/api/holds/picture")
    def holds_picture():
        """The picture of every hold on the wall that touch screens draw
        (wall_picture): its URL, the wall inches it covers, and which bolt
        holes (indexes into the board's list of them) are under a hold."""
        args = request.args
        ppi = optional_int(args.get("ppi"))
        border = optional_int(args.get("border"))
        tint = optional_int(args.get("tint"))
        if ppi not in PICTURE_PPI:
            bad_request("ppi must be one of %s" % ", ".join(map(str, PICTURE_PPI)))
        if border is None or not 1 <= border <= PICTURE_BORDER_MAX:
            bad_request("border must be 1 to %d pixels" % PICTURE_BORDER_MAX)
        if tint is None or not 0 <= tint <= 100 or tint % 5:
            bad_request("tint must be 0 to 100 in steps of 5")
        name, covered = wall_picture(db.get_db(), app.config["UPLOAD_DIR"], ppi, border, tint)
        return jsonify({
            "url": "/uploads/holds/board/" + name,
            "x": geometry.MIN_X, "y": geometry.MIN_Y,
            "width": geometry.MAX_X - geometry.MIN_X, "height": geometry.TOTAL_HEIGHT - geometry.MIN_Y,
            "covered": covered,
        })

    # ---- board & holds ----------------------------------------------------

    @app.get("/api/board")
    def board():
        return jsonify(geometry.board_spec())

    @app.get("/api/hold-names")
    def hold_name_list():
        return jsonify(hold_names.NOUNS)

    @app.get("/api/holds")
    def holds():
        # ?ppi= sizes the board images for the screen asking (BOARD_PPI).
        ppi = board_ppi(request.args.get("ppi"))
        return jsonify([serialize_hold(h, ppi) for h in db.rows(db.get_db().execute(HOLD_SELECT + " ORDER BY id"))])

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
            remove_image(old_image)
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
            remove_image(image)
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

    # The admin is flagged, as choosing them asks for their password (auth.py).
    @app.get("/api/climbers")
    def list_climbers():
        climbers = db.rows(db.get_db().execute("SELECT id, name FROM climbers ORDER BY name COLLATE NOCASE"))
        admin_id = auth.admin_climber_id()
        for c in climbers:
            c["is_admin"] = c["id"] == admin_id
        return jsonify(climbers)

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
    @app.get("/api/climbers/<int:climber_id>/days")
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
        # Publishing a draft: it goes once the climb is in (one already gone is fine).
        draft_id = optional_int(data.get("draft_id"))
        if draft_id is not None:
            conn.execute("DELETE FROM drafts WHERE id = ?", (draft_id,))
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

    @app.post("/api/routes/<int:route_id>/draft")
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

    # ---- drafts -----------------------------------------------------------

    @app.get("/api/drafts")
    def list_drafts():
        conn = db.get_db()
        drafts = db.rows(conn.execute(DRAFT_SELECT + " ORDER BY d.updated_at DESC, d.id DESC"))
        return jsonify(serialize_drafts(conn, drafts))

    @app.get("/api/drafts/<int:draft_id>")
    def get_draft(draft_id):
        return jsonify(get_draft_or_404(db.get_db(), draft_id))

    @app.post("/api/drafts")
    def create_draft():
        conn = db.get_db()
        data = request.get_json(silent=True) or {}
        draft_id = insert_draft(conn, draft_fields(conn, data), data.get("holds") or [])
        conn.commit()
        return jsonify(get_draft_or_404(conn, draft_id)), 201

    @app.put("/api/drafts/<int:draft_id>")
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

    @app.delete("/api/drafts/<int:draft_id>")
    def delete_draft(draft_id):
        conn = db.get_db()
        get_draft_or_404(conn, draft_id)
        conn.execute("DELETE FROM drafts WHERE id = ?", (draft_id,))
        conn.commit()
        return jsonify({"deleted": draft_id})

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

    def get_send_or_404(conn, send_id):
        send = db.row(conn.execute("SELECT * FROM sends WHERE id = ?", (send_id,)))
        if send is None:
            not_found("Send not found")
        return send

    @app.put("/api/sends/<int:send_id>")
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

    @app.delete("/api/sends/<int:send_id>")
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

    # ---- tries --------------------------------------------------------------
    # A mark that a climber tried a climb on a day (schema.sql): one per day,
    # so marking it again that day just updates the note.

    def get_try_or_404(conn, try_id):
        t = db.row(conn.execute("SELECT * FROM tries WHERE id = ?", (try_id,)))
        if t is None:
            not_found("Try not found")
        return t

    @app.post("/api/tries")
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

    @app.put("/api/tries/<int:try_id>")
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

    @app.delete("/api/tries/<int:try_id>")
    def delete_try(try_id):
        conn = db.get_db()
        t = get_try_or_404(conn, try_id)
        auth.guard_climber(t["climber_id"])
        conn.execute("DELETE FROM tries WHERE id = ?", (try_id,))
        conn.commit()
        return jsonify({"deleted": try_id})

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


def set_admin(db_path, name):
    password = getpass.getpass("Password for %s: " % name)
    if getpass.getpass("Again: ") != password:
        raise SystemExit("The passwords don't match.")
    conn = db.connect(db_path)
    try:
        auth.set_admin(conn, name, password)
    except ValueError as exc:
        raise SystemExit(str(exc))
    finally:
        conn.close()
    print("%s is the admin. Choosing %s in the app now asks for this password." % (name.strip(), name.strip()))


def main():
    parser = argparse.ArgumentParser(description="The Yuzu Board: a home bouldering wall route tracker")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=5050)
    parser.add_argument("--db", default=db.DEFAULT_DB_PATH)
    parser.add_argument("--uploads", help="folder for hold images (default: uploads/holds)")
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--set-admin", metavar="NAME",
                        help="make this climber the admin, asking for their password, then exit")
    args = parser.parse_args()

    app = create_app(args.db, args.uploads)
    if args.set_admin:
        set_admin(args.db, args.set_admin)
        return
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
