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

-- App-wide values, as text: `secret_key` signs the login cookie (made on the
-- first run); `admin_climber_id` and `admin_password_hash` are the admin's
-- login, set with `python app.py --set-admin <name>` (auth.py).
CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);

-- A climber tried a climb on a day, whether or not they sent it then. One
-- mark per climb, climber and day: attempts aren't counted. Sends stay in
-- `sends`; a day with either counts as a day on the wall.
CREATE TABLE IF NOT EXISTS tries (
    id          INTEGER PRIMARY KEY,
    route_id    INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    climber_id  INTEGER NOT NULL REFERENCES climbers(id) ON DELETE CASCADE,
    tried_date  TEXT NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (route_id, climber_id, tried_date)
);

-- The admin's outdoor climbing (outdoor.py). A climb is a boulder or route at
-- a crag, `area`; its grade is free text ("V5", "6B+"). A session is a day
-- out; each entry is a climb tried that day, sent or not, with a note on what
-- was learned on it. No two climbs in an area share a name (ignoring case).
-- `prior_sessions` counts the sessions on a climb before any were logged
-- here, so an entry knows it was the climb's 5th session.
CREATE TABLE IF NOT EXISTS outdoor_climbs (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    area            TEXT NOT NULL DEFAULT '',
    grade           TEXT NOT NULL DEFAULT '',
    notes           TEXT NOT NULL DEFAULT '',
    prior_sessions  INTEGER NOT NULL DEFAULT 0 CHECK (prior_sessions >= 0),
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outdoor_sessions (
    id            INTEGER PRIMARY KEY,
    session_date  TEXT NOT NULL,
    area          TEXT NOT NULL DEFAULT '',
    notes         TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outdoor_entries (
    id          INTEGER PRIMARY KEY,
    session_id  INTEGER NOT NULL REFERENCES outdoor_sessions(id) ON DELETE CASCADE,
    climb_id    INTEGER NOT NULL REFERENCES outdoor_climbs(id) ON DELETE CASCADE,
    sent        INTEGER NOT NULL DEFAULT 0 CHECK (sent IN (0, 1)),
    note        TEXT NOT NULL DEFAULT '',
    position    INTEGER NOT NULL DEFAULT 0,
    UNIQUE (session_id, climb_id)
);

-- The admin's workouts (workouts.py). An exercise is measured one way, its
-- `kind`: weight (weight × reps), bodyweight (reps, perhaps with added
-- weight), timed (seconds, perhaps with added weight) or hang (seconds, added
-- weight and edge depth). Its variants are the ways of doing it (Barbell and
-- Dumbbell bench press, a hang's grips), kept under the one exercise for its
-- history and charts. New databases start with db.DEFAULT_EXERCISES.
CREATE TABLE IF NOT EXISTS exercises (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    kind        TEXT NOT NULL CHECK (kind IN ('weight', 'bodyweight', 'timed', 'hang')),
    notes       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS exercise_variants (
    id           INTEGER PRIMARY KEY,
    exercise_id  INTEGER NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    position     INTEGER NOT NULL DEFAULT 0
);

-- One workout a day, keyed by its date. `tiredness` is how tired the session
-- felt overall, 1 (fresh) to 5 (wrecked). Each exercise done is a block, in
-- `position` order, holding its sets; a set fills the columns its exercise's
-- kind uses and leaves the rest null. Weights are in pounds; a negative one
-- is assistance (a pulley taking weight off a hang). Exercises and variants
-- that have been done can't be deleted.
CREATE TABLE IF NOT EXISTS workouts (
    id            INTEGER PRIMARY KEY,
    workout_date  TEXT NOT NULL UNIQUE,
    tiredness     INTEGER CHECK (tiredness BETWEEN 1 AND 5),
    notes         TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workout_exercises (
    id           INTEGER PRIMARY KEY,
    workout_id   INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
    exercise_id  INTEGER NOT NULL REFERENCES exercises(id) ON DELETE RESTRICT,
    variant_id   INTEGER REFERENCES exercise_variants(id) ON DELETE RESTRICT,
    position     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS workout_sets (
    id                   INTEGER PRIMARY KEY,
    workout_exercise_id  INTEGER NOT NULL REFERENCES workout_exercises(id) ON DELETE CASCADE,
    position             INTEGER NOT NULL DEFAULT 0,
    reps                 INTEGER,
    weight               REAL,
    seconds              REAL,
    edge_mm              REAL
);

CREATE INDEX IF NOT EXISTS idx_tries_climber ON tries(climber_id, tried_date);
CREATE INDEX IF NOT EXISTS idx_tries_route ON tries(route_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outdoor_climbs_name ON outdoor_climbs(name COLLATE NOCASE, area COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_outdoor_entries_climb ON outdoor_entries(climb_id);
CREATE INDEX IF NOT EXISTS idx_outdoor_sessions_date ON outdoor_sessions(session_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_variants_name ON exercise_variants(exercise_id, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_workout_exercises_exercise ON workout_exercises(exercise_id, variant_id);
CREATE INDEX IF NOT EXISTS idx_workout_exercises_workout ON workout_exercises(workout_id);
CREATE INDEX IF NOT EXISTS idx_workout_sets_block ON workout_sets(workout_exercise_id);

-- The admin's finger health (fingers.py): a check at the start or the end of a
-- day's session, or only at the end on a rest day. `scores` is a JSON list of
-- 10 scores, 0 (healthy) to 10 (most painful), in fingers.FINGERS order: the
-- left thumb, index, middle, ring and pinky, then the right hand's.
CREATE TABLE IF NOT EXISTS finger_checks (
    id          INTEGER PRIMARY KEY,
    check_date  TEXT NOT NULL,
    phase       TEXT NOT NULL CHECK (phase IN ('start', 'end')),
    scores      TEXT NOT NULL,
    comment     TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (check_date, phase)
);
