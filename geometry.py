"""Board geometry for the home wall. All measurements are in inches.

Coordinates used everywhere else in the app are measured from the main
panel's top-left corner (x grows to the right, y grows downward), which is
what SVG expects. T-nut columns, however, are counted from the RIGHT edge and
labelled with letters (A = rightmost), while rows are counted from the top and
labelled with numbers (1 = topmost).

Below the main panel, after a small gap, sits the footboard. Its two rows
continue the numbering (40, 41) and its columns are lettered A′, B′, … from
the right. A t-nut's row index tells which panel it is on.

Beside the main panel, after the same small gap on either side, stand two
narrow side panels with no t-nuts at all, from the top of the wall to the
bottom of the main panel. The left one lies at negative x. Holds on them have
no nearest t-nut; their names start with the panel's letter (L or R).

Above the main panel, after the same small gap, the ceiling spans its width.
It lies at negative y and has no t-nuts either, but the main panel's columns
carry on across it, so its holds' names start with their column's letter.
"""
import math

# ---- main panel -------------------------------------------------------------
COLS = 40
ROWS = 39
SPACING = 3.0

FIRST_HOLE_FROM_RIGHT = 1.5
FIRST_HOLE_FROM_TOP = 2.75
MARGIN_LEFT = 1.5     # wall beyond the last (leftmost) column
MARGIN_BOTTOM = 2.0   # wall beyond the last (bottom) row

WIDTH = FIRST_HOLE_FROM_RIGHT + (COLS - 1) * SPACING + MARGIN_LEFT
HEIGHT = FIRST_HOLE_FROM_TOP + (ROWS - 1) * SPACING + MARGIN_BOTTOM

# ---- footboard --------------------------------------------------------------
FOOT_GAP = 1.0                    # between the main panel and the footboard
FOOT_TOP = HEIGHT + FOOT_GAP
FOOT_HEIGHT = 8.0
FOOT_FIRST_FROM_RIGHT = 4.0
FOOT_COL_SPACING = 8.0
FOOT_COLS = int((WIDTH - 2 * FOOT_FIRST_FROM_RIGHT) // FOOT_COL_SPACING) + 1
FOOT_ROW_OFFSETS = (2.5, FOOT_HEIGHT - 2.5)   # from the footboard's top edge
FOOT_ROW_SPACING = FOOT_ROW_OFFSETS[1] - FOOT_ROW_OFFSETS[0]
FOOT_ROWS = len(FOOT_ROW_OFFSETS)

TOTAL_HEIGHT = FOOT_TOP + FOOT_HEIGHT
PRIME = "′"

# ---- side panels --------------------------------------------------------------
SIDE_WIDTH = 8.0
SIDE_GAP = 1.0                    # between each side panel and the main panel
LEFT_X = -(SIDE_GAP + SIDE_WIDTH)  # each side panel's left edge
RIGHT_X = WIDTH + SIDE_GAP
SIDE_LETTERS = {"left": "L", "right": "R"}
SIDE_NAMES = {"left": "Left panel", "right": "Right panel"}
MIN_X = LEFT_X                    # the wall's outer edges
MAX_X = RIGHT_X + SIDE_WIDTH

# ---- ceiling ----------------------------------------------------------------
CEIL_HEIGHT = 18.0
CEIL_GAP = 1.0                    # between the main panel and the ceiling
CEIL_TOP = -(CEIL_GAP + CEIL_HEIGHT)
CEIL_BOTTOM = -CEIL_GAP
CEIL_NAME = "Ceiling"
MIN_Y = CEIL_TOP                  # the wall's top edge

TNUT_FREE = {"left", "right", "ceiling"}   # the panels without t-nuts


def is_foot_row(row):
    return row >= ROWS


def col_label(col):
    """0 -> 'A', 25 -> 'Z', 26 -> 'AA', ... 39 -> 'AN'."""
    label = ""
    n = col + 1
    while n:
        n, rem = divmod(n - 1, 26)
        label = chr(ord("A") + rem) + label
    return label


def row_label(row):
    return str(row + 1)


def tnut_label(col, row):
    """'F12' on the main panel, 'C′40' on the footboard."""
    return col_label(col) + (PRIME if is_foot_row(row) else "") + row_label(row)


def tnut_xy(col, row):
    """Position of a t-nut hole, measured from the main panel's top-left corner."""
    if is_foot_row(row):
        x = WIDTH - (FOOT_FIRST_FROM_RIGHT + col * FOOT_COL_SPACING)
        y = FOOT_TOP + FOOT_ROW_OFFSETS[row - ROWS]
        return x, y
    x = WIDTH - (FIRST_HOLE_FROM_RIGHT + col * SPACING)
    y = FIRST_HOLE_FROM_TOP + row * SPACING
    return x, y


def panel_of(x, y):
    """'main', 'foot', 'left', 'right', 'ceiling', or None for points off
    the wall (including the gaps)."""
    if 0 <= x <= WIDTH:
        if 0 <= y <= HEIGHT:
            return "main"
        if FOOT_TOP <= y <= TOTAL_HEIGHT:
            return "foot"
        if CEIL_TOP <= y <= CEIL_BOTTOM:
            return "ceiling"
        return None
    if not 0 <= y <= HEIGHT:
        return None
    if LEFT_X <= x <= LEFT_X + SIDE_WIDTH:
        return "left"
    if RIGHT_X <= x <= MAX_X:
        return "right"
    return None


def on_panel(x, y):
    """True when a point lies on one of the panels (not a gap)."""
    return panel_of(x, y) is not None


def tnut_free(x, y):
    """True on a panel with no t-nuts: a side panel or the ceiling."""
    return panel_of(x, y) in TNUT_FREE


def bolt_holes():
    """The bolt holes' centres, in the order the board draws them (board.js
    holeSpots): the main panel's column by column, A first, where column and
    row add up to an even number (they're staggered), then the footboard's."""
    main = [tnut_xy(c, r) for c in range(COLS) for r in range(ROWS) if (c + r) % 2 == 0]
    return main + [tnut_xy(c, ROWS + r) for c in range(FOOT_COLS) for r in range(FOOT_ROWS)]


def nearest_tnut(x, y):
    """(col, row, distance) of the t-nut closest to a point on the wall.

    Points below the middle of the gap belong to the footboard. Rounds with
    floor(v + 0.5) so the browser (Math.floor) agrees exactly. On the ceiling
    this is the top row's t-nut in the point's column.
    """
    if y >= HEIGHT + FOOT_GAP / 2:
        first_x, first_y = tnut_xy(0, ROWS)
        col = math.floor((first_x - x) / FOOT_COL_SPACING + 0.5)
        row = math.floor((y - first_y) / FOOT_ROW_SPACING + 0.5)
        col = min(max(col, 0), FOOT_COLS - 1)
        row = ROWS + min(max(row, 0), FOOT_ROWS - 1)
    else:
        col = math.floor((WIDTH - FIRST_HOLE_FROM_RIGHT - x) / SPACING + 0.5)
        row = math.floor((y - FIRST_HOLE_FROM_TOP) / SPACING + 0.5)
        col = min(max(col, 0), COLS - 1)
        row = min(max(row, 0), ROWS - 1)
    tx, ty = tnut_xy(col, row)
    return col, row, math.hypot(x - tx, y - ty)


def name_letter(col):
    """Hold names start with the column's letter; AA..AN use the second letter
    and footboard columns (A′, B′, …) the plain letter."""
    return col_label(col)[-1]


def hold_letter(x, y):
    """The letter a hold's name starts with: its side panel's, or else its
    column's (the nearest t-nut's, or on the ceiling the one it's under)."""
    panel = panel_of(x, y)
    if panel in SIDE_LETTERS:
        return SIDE_LETTERS[panel]
    return name_letter(nearest_tnut(x, y)[0])


def hold_grid(x, y, col, row):
    """Where a hold is, for people: its side panel, its column on the
    ceiling, or else its nearest t-nut."""
    panel = panel_of(x, y)
    if panel in SIDE_NAMES:
        return SIDE_NAMES[panel]
    if panel == "ceiling":
        return "%s, column %s" % (CEIL_NAME, col_label(nearest_tnut(x, y)[0]))
    return tnut_label(col, row)


def board_spec():
    foot_rows = range(ROWS, ROWS + FOOT_ROWS)
    return {
        "width": WIDTH,
        "height": HEIGHT,
        "total_height": TOTAL_HEIGHT,
        "min_x": MIN_X,
        "max_x": MAX_X,
        "min_y": MIN_Y,
        "cols": COLS,
        "rows": ROWS,
        "spacing": SPACING,
        "col_x": [tnut_xy(c, 0)[0] for c in range(COLS)],
        "row_y": [tnut_xy(0, r)[1] for r in range(ROWS)],
        "col_labels": [col_label(c) for c in range(COLS)],
        "row_labels": [row_label(r) for r in range(ROWS)],
        "foot": {
            "top": FOOT_TOP,
            "height": FOOT_HEIGHT,
            "gap": FOOT_GAP,
            "cols": FOOT_COLS,
            "rows": FOOT_ROWS,
            "col_spacing": FOOT_COL_SPACING,
            "row_spacing": FOOT_ROW_SPACING,
            "col_x": [tnut_xy(c, ROWS)[0] for c in range(FOOT_COLS)],
            "row_y": [tnut_xy(0, r)[1] for r in foot_rows],
            "col_labels": [col_label(c) + PRIME for c in range(FOOT_COLS)],
            "row_labels": [row_label(r) for r in foot_rows],
        },
        "sides": {
            "width": SIDE_WIDTH,
            "gap": SIDE_GAP,
            "top": 0,
            "height": HEIGHT,
            "left_x": LEFT_X,
            "right_x": RIGHT_X,
            "letters": SIDE_LETTERS,
            "names": SIDE_NAMES,
        },
        "ceiling": {
            "top": CEIL_TOP,
            "height": CEIL_HEIGHT,
            "gap": CEIL_GAP,
            "name": CEIL_NAME,
        },
    }
