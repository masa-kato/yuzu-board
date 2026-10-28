import os
import random
import sqlite3

from flask import current_app, g

import geometry
import hold_names

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB_PATH = os.path.join(HERE, "homewall.db")
SCHEMA_PATH = os.path.join(HERE, "schema.sql")

# Columns added to `holds` after the first release, for databases that predate them.
HOLD_COLUMNS = [
    ("name", "TEXT"),
    ("image", "TEXT"),
    ("size", "REAL NOT NULL DEFAULT 6"),
    ("rotation", "REAL NOT NULL DEFAULT 0"),
    ("color", "TEXT"),
    ("color_opacity", "REAL NOT NULL DEFAULT 0.5"),
    ("removed_at", "TEXT"),
]

# Columns added to `volumes` later.
VOLUME_COLUMNS = [
    ("faces", "TEXT NOT NULL DEFAULT '[]'"),
]

# The color list a new database starts with (and an older one, when it first
# gains the `colors` table). After that the list is edited in the app.
DEFAULT_COLORS = [
    ("Red", "#7a0404"),
    ("Orange", "#e8590c"),
    ("Yellow", "#f2c200"),
    ("Lime", "#7cb518"),
    ("Green", "#1e8a3c"),
    ("Teal", "#0f8b8d"),
    ("Blue", "#1e3a8a"),
    ("Navy", "#1e2a78"),
    ("Purple", "#4c1d95"),
    ("Pink", "#e64980"),
    ("Brown", "#7a4a1d"),
    ("Wood", "#eecbb0"),
    ("Black", "#111111"),
    ("Grey", "#8a8f98"),
    ("White", "#f1f1f1"),
]


def connect(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(conn):
    # Only a database that has never had the color list gets the defaults, so
    # an edited list (even an emptied one) is never refilled.
    had_colors = conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'colors'").fetchone()
    with open(SCHEMA_PATH) as f:
        conn.executescript(f.read())
    if not had_colors:
        conn.executemany("INSERT INTO colors (name, hex, position) VALUES (?, ?, ?)",
                         [(name, hex_, i) for i, (name, hex_) in enumerate(DEFAULT_COLORS)])
    migrate(conn)
    conn.commit()


def migrate(conn):
    for table, columns in (("holds", HOLD_COLUMNS), ("volumes", VOLUME_COLUMNS)):
        have = {r["name"] for r in conn.execute("PRAGMA table_info(%s)" % table)}
        for column, decl in columns:
            if column not in have:
                conn.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, column, decl))

    for h in conn.execute("SELECT id, x, y FROM holds WHERE tnut_col IS NULL OR tnut_row IS NULL").fetchall():
        col, row, _ = geometry.nearest_tnut(h["x"], h["y"])
        conn.execute("UPDATE holds SET tnut_col = ?, tnut_row = ? WHERE id = ?", (col, row, h["id"]))

    # No two holds share a name, removed ones included. Older databases only
    # kept names unique on the wall, so where two holds share one, the hold
    # on the wall (or else the older one) keeps it and the other gets a new
    # name; then the index keeps it that way.
    holds = conn.execute("SELECT id, name, tnut_col FROM holds ORDER BY removed_at IS NOT NULL, id").fetchall()
    taken = {h["name"].lower() for h in holds if h["name"]}
    kept = set()
    rng = random.Random(0)
    for h in holds:
        if h["name"] and h["name"].lower() not in kept:
            kept.add(h["name"].lower())
            continue
        name = hold_names.suggest_name(taken, geometry.name_letter(h["tnut_col"]), rng=rng)
        taken.add(name.lower())
        kept.add(name.lower())
        conn.execute("UPDATE holds SET name = ? WHERE id = ?", (name, h["id"]))
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_holds_name ON holds (name COLLATE NOCASE)")

    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_holds_active_name "
        "ON holds(name COLLATE NOCASE) WHERE removed_at IS NULL"
    )


def get_db():
    if "db" not in g:
        g.db = connect(current_app.config["DATABASE"])
    return g.db


def close_db(_exc=None):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def rows(cursor):
    return [dict(r) for r in cursor.fetchall()]


def row(cursor):
    r = cursor.fetchone()
    return dict(r) if r is not None else None
