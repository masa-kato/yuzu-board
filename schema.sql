CREATE TABLE IF NOT EXISTS climbers (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A physical hold on the wall. x/y are inches from the wall's top-left corner
-- and need not sit on a t-nut; tnut_col/tnut_row record the nearest t-nut,
-- whose column letter the hold's name starts with. Holds without an `image`
-- (a PNG under uploads/holds/) are drawn as proxy circles. `size` is the
-- image's longest side in inches; `color` (#rrggbb) is laid over the PNG (at
-- one opacity for every hold, set in the browser; `color_opacity` is no longer
-- used). Removing a hold only sets removed_at, so routes that used it can
-- still be shown in Legacy. No two holds share a name (ignoring case),
-- removed ones included: db.migrate() creates that index (idx_holds_name).
-- Older databases gain the newer columns through db.migrate().
CREATE TABLE IF NOT EXISTS holds (
    id             INTEGER PRIMARY KEY,
    name           TEXT,
    x              REAL NOT NULL,
    y              REAL NOT NULL,
    tnut_col       INTEGER,
    tnut_row       INTEGER,
    image          TEXT,
    size           REAL NOT NULL DEFAULT 6,
    rotation       REAL NOT NULL DEFAULT 0,
    color          TEXT,
    color_opacity  REAL NOT NULL DEFAULT 0.5,
    removed_at     TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A route (problem). Rows with parent_id set are variations of that route.
CREATE TABLE IF NOT EXISTS routes (
    id             INTEGER PRIMARY KEY,
    name           TEXT NOT NULL,
    parent_id      INTEGER REFERENCES routes(id) ON DELETE CASCADE,
    grade          TEXT NOT NULL CHECK (grade IN ('warmup', 'easy', 'medium', 'hard', 'project')),
    setter_id      INTEGER REFERENCES climbers(id) ON DELETE SET NULL,
    set_date       TEXT NOT NULL,
    fa_climber_id  INTEGER REFERENCES climbers(id) ON DELETE SET NULL,
    fa_date        TEXT,
    notes          TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS route_holds (
    route_id  INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    hold_id   INTEGER NOT NULL REFERENCES holds(id) ON DELETE CASCADE,
    role      TEXT NOT NULL CHECK (role IN ('start', 'hand', 'foot', 'finish')),
    PRIMARY KEY (route_id, hold_id)
);

-- A climb being set but not published yet: what the Set boulder form held when
-- Save draft was pressed. Drafts are shared by everyone and live apart from
-- `routes`, so they never show in the climb lists, stats or circuits. The name
-- and set date may be blank until it is published (POST /api/routes with
-- draft_id), which deletes the draft. `saved_by` is whoever saved it last.
-- Ids are never reused, so a page still open on a published draft can't
-- overwrite a newer one.
CREATE TABLE IF NOT EXISTS drafts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL DEFAULT '',
    parent_id   INTEGER REFERENCES routes(id) ON DELETE CASCADE,
    grade       TEXT NOT NULL CHECK (grade IN ('warmup', 'easy', 'medium', 'hard', 'project')),
    setter_id   INTEGER REFERENCES climbers(id) ON DELETE SET NULL,
    set_date    TEXT,
    notes       TEXT NOT NULL DEFAULT '',
    saved_by    INTEGER REFERENCES climbers(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- A draft's holds, as route_holds. Deleting a hold for good drops it from drafts.
CREATE TABLE IF NOT EXISTS draft_holds (
    draft_id  INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    hold_id   INTEGER NOT NULL REFERENCES holds(id) ON DELETE CASCADE,
    role      TEXT NOT NULL CHECK (role IN ('start', 'hand', 'foot', 'finish')),
    PRIMARY KEY (draft_id, hold_id)
);

-- One row per send. Repeats are derived: any send after a climber's first
-- send of the same route.
CREATE TABLE IF NOT EXISTS sends (
    id          INTEGER PRIMARY KEY,
    route_id    INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    climber_id  INTEGER NOT NULL REFERENCES climbers(id) ON DELETE CASCADE,
    sent_date   TEXT NOT NULL,
    comment     TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Wooden volumes bolted to the wall. Pure scenery: drawn behind the holds,
-- never named or used in routes. `points` is a JSON list of [x, y] corners in
-- wall inches, in drawing order, all on one panel. `faces` is a JSON list of
-- sub-polygons (each a list of [x, y] corners) drawn as thin lines inside the
-- outline, to show the volume's sides. Older databases gain it via db.migrate().
CREATE TABLE IF NOT EXISTS volumes (
    id          INTEGER PRIMARY KEY,
    points      TEXT NOT NULL,
    color       TEXT NOT NULL CHECK (color IN ('black', 'green')),
    faces       TEXT NOT NULL DEFAULT '[]',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A circuit: a named, ordered playlist of climbs, shared by everyone. A climb
-- appears at most once per circuit; `position` orders it (gaps are fine).
CREATE TABLE IF NOT EXISTS circuits (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_by  INTEGER REFERENCES climbers(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS circuit_routes (
    circuit_id  INTEGER NOT NULL REFERENCES circuits(id) ON DELETE CASCADE,
    route_id    INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    PRIMARY KEY (circuit_id, route_id)
);

-- The named colors offered for holds, shared by everyone, in `position` order.
-- Holds store the hex itself, so a hold uses a color when their hexes match;
-- changing a color's hex recolors those holds (app.py). New databases start
-- with db.DEFAULT_COLORS.
CREATE TABLE IF NOT EXISTS colors (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    hex         TEXT NOT NULL,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_colors_name ON colors(name COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS idx_colors_hex ON colors(hex);
CREATE INDEX IF NOT EXISTS idx_routes_parent ON routes(parent_id);
CREATE INDEX IF NOT EXISTS idx_circuit_routes_route ON circuit_routes(route_id);
CREATE INDEX IF NOT EXISTS idx_route_holds_hold ON route_holds(hold_id);
CREATE INDEX IF NOT EXISTS idx_draft_holds_hold ON draft_holds(hold_id);
CREATE INDEX IF NOT EXISTS idx_sends_route ON sends(route_id, climber_id);
CREATE INDEX IF NOT EXISTS idx_sends_climber ON sends(climber_id, sent_date);
