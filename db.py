import os
import random
import re
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

# The grades a climb can have (app.py GRADES). Warm-up came later, so older
# `routes` and `drafts` tables check for the four others (widen_grades).
GRADE_CHECK = "CHECK (grade IN ('warmup', 'easy', 'medium', 'hard', 'project'))"

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


def widen_grades(conn):
    """Lets an older `routes` or `drafts` table take the Warm-up grade. SQLite
    can't change a table's CHECK, so the table is rebuilt (SQLite's own recipe:
    a new table with the wider CHECK, the rows copied over, the old table
    dropped and the new one renamed), keeping every row and id. Foreign keys
    are off meanwhile, so nothing that points at a climb is touched."""
    old = {}
    for name in ("routes", "drafts"):
        r = conn.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)).fetchone()
        if r and "'warmup'" not in r["sql"]:
            old[name] = r["sql"]
    if not old:
        return
    conn.commit()   # foreign keys can only be switched outside a transaction
    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        conn.execute("BEGIN")
        # Draft ids are never reused (schema.sql), so their counter carries over.
        seq = conn.execute("SELECT seq FROM sqlite_sequence WHERE name = 'drafts'").fetchone() if "drafts" in old else None
        for name, sql in old.items():
            sql = re.sub(r"CHECK\s*\(\s*grade\s+IN\s*\([^)]*\)\s*\)", GRADE_CHECK, sql, count=1)
            sql = re.sub(r'^CREATE TABLE\s+"?%s"?' % name, "CREATE TABLE %s_new" % name, sql, count=1)
            conn.execute(sql)
            conn.execute("INSERT INTO %s_new SELECT * FROM %s" % (name, name))
            conn.execute("DROP TABLE %s" % name)
            conn.execute("ALTER TABLE %s_new RENAME TO %s" % (name, name))
        if seq:
            conn.execute("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'drafts'", (seq["seq"],))
            if not conn.execute("SELECT 1 FROM sqlite_sequence WHERE name = 'drafts'").fetchone():
                conn.execute("INSERT INTO sqlite_sequence (name, seq) VALUES ('drafts', ?)", (seq["seq"],))
        conn.execute("CREATE INDEX IF NOT EXISTS idx_routes_parent ON routes(parent_id)")
        broken = conn.execute("PRAGMA foreign_key_check").fetchall()
        if broken:
            raise sqlite3.IntegrityError("Foreign keys broken by the grade migration: %r" % [tuple(b) for b in broken])
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.execute("PRAGMA foreign_keys = ON")


def migrate(conn):
    widen_grades(conn)
    for table, columns in (("holds", HOLD_COLUMNS), ("volumes", VOLUME_COLUMNS)):
        have = {r["name"] for r in conn.execute("PRAGMA table_info(%s)" % table)}
        for column, decl in columns:
            if column not in have:
                conn.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, column, decl))

    # Holds on a side panel or the ceiling have no t-nut, so they keep none.
    for h in conn.execute("SELECT id, x, y FROM holds WHERE tnut_col IS NULL OR tnut_row IS NULL").fetchall():
        if geometry.tnut_free(h["x"], h["y"]):
            continue
        col, row, _ = geometry.nearest_tnut(h["x"], h["y"])
        conn.execute("UPDATE holds SET tnut_col = ?, tnut_row = ? WHERE id = ?", (col, row, h["id"]))

    # No two holds share a name, removed ones included. Older databases only
    # kept names unique on the wall, so where two holds share one, the hold
    # on the wall (or else the older one) keeps it and the other gets a new
    # name; then the index keeps it that way.
    holds = conn.execute("SELECT id, name, x, y FROM holds ORDER BY removed_at IS NOT NULL, id").fetchall()
    taken = {h["name"].lower() for h in holds if h["name"]}
    kept = set()
    rng = random.Random(0)
    for h in holds:
        if h["name"] and h["name"].lower() not in kept:
            kept.add(h["name"].lower())
            continue
        name = hold_names.suggest_name(taken, geometry.hold_letter(h["x"], h["y"]), rng=rng)
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
