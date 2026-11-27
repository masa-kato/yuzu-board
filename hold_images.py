"""Hold images: the PNGs uploaded for holds (uploads/holds/), the smaller
copies of them the board draws (uploads/holds/board/, each made the first
time it's asked for), and the picture of every hold on the wall that touch
screens draw instead (board.js LIGHT). Everything under board/ is a cache:
deleting it only means it's made again."""

import functools
import glob
import hashlib
import json
import math
import os
import re
import shutil
import uuid

from flask import Blueprint, abort, current_app, jsonify, request, send_from_directory
from PIL import Image, ImageChops

import db
import geometry
from helpers import bad_request, optional_int

bp = Blueprint("hold_images", __name__)

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_UPLOAD_DIR = os.path.join(HERE, "uploads", "holds")
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
STORED_PNG_RE = re.compile(r"^[0-9a-f]{32}\.png$")
# The board shows each hold image as a smaller copy, a number of pixels per
# inch of the hold's size. A screen asks for what it needs to stay sharp at its
# closest zoom (?ppi= on /api/holds) and gets the smallest of BOARD_PPI that
# covers it: a phone, which stops at 4×, about 32 to 40; a retina laptop at 6×
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
# at one of PICTURE_PPI pixels per inch: sharp at their closest zoom, or on a
# phone to about 2.5× of its 4× (a larger picture would load and draw slower).
PICTURE_PPI = (12, 16, 20)
PICTURE_BORDER_MAX = 16
PICTURE_KEEP = 8   # pictures kept on disk; older ones are deleted
WALL_PICTURE_RE = re.compile(r"^wall-[0-9a-f]{20}\.webp$")
# Image files never change: a new image gets a new name.
IMAGE_MAX_AGE = 365 * 24 * 3600


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


def clear_uploads(upload_dir):
    """Deletes every uploaded hold image in `upload_dir` and the board's
    copies, for a database started over (seed.py --reset). Other files are
    left alone."""
    if not os.path.isdir(upload_dir):
        return
    for name in os.listdir(upload_dir):
        if STORED_PNG_RE.match(name):
            os.remove(os.path.join(upload_dir, name))
    shutil.rmtree(os.path.join(upload_dir, "board"), ignore_errors=True)


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


@functools.lru_cache(maxsize=None)
def image_size(path):
    """A stored hold image's (width, height) in pixels, or None when it's
    gone. Read once: an image never changes (a new one gets a new name)."""
    try:
        with Image.open(path) as im:
            return im.size
    except OSError:
        return None


def extent(image, size):
    """The width and height a hold is drawn at, in inches before its
    rotation: its image fitted to `size` on its longest side, as the board
    draws it; None when it has no image. The photos are cut out close to the
    hold, so phones pick the hold a tap is nearest by it (board.js holdNear)
    without fetching the image."""
    if not image or not STORED_PNG_RE.match(image):
        return None
    pixels = image_size(os.path.join(current_app.config["UPLOAD_DIR"], image))
    if not pixels:
        return None
    longest = max(pixels)
    return [round(size * side / longest, 2) for side in pixels]


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


@bp.get("/uploads/holds/<path:filename>")
def hold_image(filename):
    return send_from_directory(current_app.config["UPLOAD_DIR"], filename, max_age=IMAGE_MAX_AGE)


@bp.get("/uploads/holds/board/<name>")
def board_image(name):
    """A hold image's copy for the board, made the first time it's asked
    for; or a picture of the whole wall's holds (made by /api/holds/picture)."""
    upload_dir = current_app.config["UPLOAD_DIR"]
    board_dir = os.path.join(upload_dir, "board")
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
    if board_copy(upload_dir, match.group(1), px, variant) is None:
        abort(404)
    return send_from_directory(board_dir, name, max_age=IMAGE_MAX_AGE)


@bp.get("/api/holds/picture")
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
    name, covered = wall_picture(db.get_db(), current_app.config["UPLOAD_DIR"], ppi, border, tint)
    return jsonify({
        "url": "/uploads/holds/board/" + name,
        "x": geometry.MIN_X, "y": geometry.MIN_Y,
        "width": geometry.MAX_X - geometry.MIN_X, "height": geometry.TOTAL_HEIGHT - geometry.MIN_Y,
        "covered": covered,
    })
