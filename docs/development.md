# Working on the Yuzu Board

How the code fits together, and what to touch to change it. The [README](../README.md) covers running and using the app.

## The shape of it

- **Server:** a Flask app (`app.py`) serves the page and a JSON API, split into blueprints, one per area. Everything is stored in one SQLite file (`homewall.db`) plus the hold images in `uploads/holds/`.
- **Browser:** one page (`static/index.html`) and plain ES modules. There's no build step: edit a `.js` or `.css` file and reload.
- **Try changes in the test app:** `deploy/mac/test-app.sh` serves this working copy on port 5051 against a copy of the live data, and restarts itself when a `.py` file changes (`--reload`). Static files are read from disk on every request, so a `.js` or `.css` change shows on reload. A server started without `--reload` or `--debug` has to be restarted after a change to Python or `schema.sql`: a page that answers "Request failed (404)" after a change is usually running against an old server.
- **Pushing to `main` deploys it.** The Pi tests each new commit and switches to it within about 2 minutes ([deploy.md](deploy.md)), and the pre-push hook runs the tests on this side first.

## Server modules

| Module | What it holds | API |
|---|---|---|
| `app.py` | `create_app()`, which registers the blueprints, and the command line (`main`, `--set-admin`) | `/`, `/api/health` |
| `wsgi.py`, `backup.py` | The app for the Pi's production server; database snapshots, pruned by age and checked ([deploy.md](deploy.md)) | |
| `climbs.py` | Climbs and variations, drafts, and the climb list's filtering and sorting. Also what "possible" and "Legacy" mean (`POSSIBLE_SQL`) | `/api/routes`, `/api/drafts` |
| `holds.py` | Holds, the shared color list, volumes, the board's geometry and hold names | `/api/holds`, `/api/colors`, `/api/volumes`, `/api/board`, `/api/hold-names` |
| `hold_images.py` | Uploaded PNGs, the smaller copies the board draws, and the touch screens' one picture of every hold | `/uploads/holds/…`, `/api/holds/picture` |
| `logbook.py` | Climbers, sends, tries, first ascents, and the calendars' days | `/api/climbers`, `/api/sends`, `/api/tries` |
| `circuits.py` | Circuits | `/api/circuits` |
| `auth.py` | The admin login, and `admin_required` / `guard_climber` for other modules | `/api/session`, `/api/login`, `/api/logout` |
| `outdoor.py`, `workouts.py`, `fingers.py` | The admin's outdoor sessions, workouts and finger checks | `/api/outdoor/…`; `/api/workouts/…`, `/api/exercises/…`; `/api/fingers/…` |
| `helpers.py` | JSON errors (`bad_request`, `not_found`), parsing submitted values, `require_climber` | |
| `db.py` | Connections (`get_db()` per request), `rows`/`row`/`in_clause`, and migrations | |
| `constants.py` | Values several modules share: `GRADES`, `ROLES` | |
| `geometry.py`, `hold_names.py` | The wall's measurements and t-nut grid; the nouns holds are named with | |
| `seed.py` | Demo data, for a database nobody has used yet | |

Each blueprint follows the same pattern: helpers that validate and serialize at the top, then the endpoints. An endpoint gets its connection from `db.get_db()`, calls `bad_request(...)` or `not_found(...)` to answer with `{"error": ...}`, commits, and returns JSON. Most write endpoints answer with the object as it now is, so the browser needn't fetch it again.

To add an area: write `thing.py` with `bp = Blueprint("thing", __name__)`, add `thing.bp` to `BLUEPRINTS` in `app.py`, add its calls to `static/js/api.js`, and add `tests/test_thing.py`.

## The database

`schema.sql` is the schema for a new database. Every statement is `CREATE … IF NOT EXISTS`, and `db.init_db()` runs it on every start, so a new table or index appears by itself. Changing an *existing* table needs a migration in `db.migrate()`, which also runs on every start and must do nothing on a database that's already up to date:

- **A new column:** add it to the table in `schema.sql` *and* to the matching list in `db.py` (`HOLD_COLUMNS`, `VOLUME_COLUMNS`, `OUTDOOR_CLIMB_COLUMNS`, or a new one in the loop in `migrate`). Older databases get it through `ALTER TABLE … ADD COLUMN`.
- **A retired column:** remove it from `schema.sql` and add it to `DROPPED_COLUMNS`.
- **A changed CHECK or constraint:** SQLite can't alter one, so the table is rebuilt. `widen_grades()` shows how, keeping every row, id and foreign key.
- **A one-off change to the data:** guard it with `PRAGMA user_version` (now 1) and raise the version, so it never runs twice.

Each migration gets a test that builds the old schema, runs `db.init_db()`, and checks the result (see `MigrationTest` in `tests/test_holds.py`).

## Values kept in more than one place

A few values live on the server, in `schema.sql`'s CHECKs, and in the browser, which has them before any request:

| Value | Server | Also in |
|---|---|---|
| Grades, hold roles | `constants.py` | `schema.sql`; `ui.js` `GRADES`, `GRADE_LEVEL`, `ROLES`; `board.js` `RING_BANDS` |
| Exercise kinds and their set fields | `workouts.py` `KINDS`, `KIND_FIELDS` | `schema.sql`; `views/workout.js` `KINDS`, `COLUMNS` |
| Finger order | `fingers.py` `FINGERS` | `hands.js` `FINGER_NAMES` |
| Name limits | `circuits.py`, `workouts.py`, `outdoor.py` | `views/shared.js`, `views/workout.js`, `views/outdoor.js` |
| The holds' picture sizes and border opacity | `hold_images.py` | `board.js` |

`tests/test_constants.py` fails when a copy differs, so change them together. Two pieces of logic are mirrored in the browser because the Wall tab needs them live while a hold is dragged: the nearest t-nut (`geometry.nearest_tnut` and `wallGeometry().nearest` in `views/holds/common.js`) and suggesting a hold name (`hold_names.suggest_name` and `suggestName` in `views/holds/placement.js`). The server always has the last word on both.

## Browser modules

| Module | What it does |
|---|---|
| `app.js` | Starts the app, keeps the shared `state`, and routes `#/…` links to pages (`PAGES`) |
| `api.js` | Every call to the server, one function each |
| `ui.js` | `h()` and `svg()` to build elements; dialogs, toasts, dates, grades, `plural`; `PHONE` and `TOUCH` (the screen media queries) |
| `board.js` | Draws the wall: holds, rings, volumes, the grid. `createBoard()` returns the board API below |
| `viewport.js` | The board's zoom and pan: buttons, keys, wheel, pinch, drag, glide, and pointers on the wall in inches |
| `calendar.js`, `chart.js`, `hands.js` | The month calendar, the progress charts, the finger-check fingertips |
| `palette.js` | The color list: the color field in forms and the dialogs that edit the list |
| `sheet.js`, `swipe.js` | On phones: the climb list's sheet, and swiping between climbs |
| `icons.js`, `names.js` | The icon set; random route names |
| `views/*.js` | One module per page, or several related pages |
| `views/shared.js` | What several views use: the climb list's query and Active, Legacy and Drafts switch, the circuit name limit |
| `views/holds/*.js` | The Wall tab's tools: `placement.js` (add or edit a hold), `recolor.js`, `volumes.js`, and `common.js` for what they share |

### Pages

A page is an entry in `PAGES` in `app.js`, keyed by the first part of its link (`#/route/12?circuit=3` is `route`). The entry says how the page draws and where it sits:

```js
route: {
  render: routeDetail.render,                                     // draws the page
  params: (raw, q) => ({ routeId: Number(raw), circuitId: idOf(q.get('circuit')) }),
  nav: (p) => (p.circuitId ? 'circuits' : 'climbs'),              // the tab it's under
},
```

The other keys are `admin` (the admin only), `computer` (not on phones), `layout` (`'calendar'` puts the calendar in the wall's place; `'solo'` centers the panel alone), `list` (only the list scrolls) and `pinned` (on phones, the board stays above that list).

`render(root, ctx, params)` draws into `root` (with `root.replaceChildren(...)`) and may return a handle:

```js
return {
  destroy() {},                    // leaving the page: remove listeners, timers
  onHoldClick(hold) {},            // a hold on the board was tapped
  onHoldHover(hold) {},            // the pointer is over a hold (null when it leaves)
  onWallPointer(type, point) {},   // in 'place' mode: 'down' | 'move' | 'up' at { x, y } inches,
                                   // with point.px (inches per screen pixel) and point.touch
};
```

`ctx` is what every page gets:

| | |
|---|---|
| `ctx.state` | The shared state (`app.js` `state`): the board's spec, holds (`holds`, `holdById`), climbers, `me`, `admin`, volumes, colors, the climb list's filters, and what each list remembers |
| `ctx.api` | `api.js` |
| `ctx.board` | The board API |
| `ctx.stale()` | True once the user has moved to another page. **Check it after every `await`** before touching the board or the page |
| `ctx.go(hash)` | Opens a page (redraws it when it's the one showing) |
| `ctx.toast(message, kind)` | A short message: `'success'`, `'error'`, `'celebrate'` or `'info'` |
| `ctx.requireMe()` | The climber's id, or `null` after asking them to choose who they are |
| `ctx.refreshHolds()`, `refreshVolumes()`, `refreshColors()`, `refreshClimbers()` | Fetch again into `state`, and redraw the board |
| `ctx.savePrefs()` | Saves the filters in `state` to this browser |
| `ctx.sidePane`, `ctx.boardEl` | The calendar's pane and the board's element |
| `ctx.climberName(id)` | A climber's name |
| `ctx.addClimber()` | Asks for a new climber's name and adds them |

**To add a tab:** write `views/thing.js` with `export async function render(root, ctx, params)`, import it in `app.js`, add it to `PAGES`, and add a link to `.tabs` in `index.html` with `data-nav` matching its `nav`. Styles go in their own `views: …` section in `static/css/app.css`.

### The board

`createBoard()` returns:

| | |
|---|---|
| `setHolds(holds)`, `setVolumes(volumes)` | What's on the wall |
| `setRoute(holds, { dim, instant })` | A climb's holds (`[{hold_id, role}]`) with their rings; the others fade unless `dim: false` |
| `preview(holds)` | Shows another climb for a moment (on hover); `null` goes back |
| `spotlight(role)` | Fades the climb's holds of every other role; `null` for all |
| `setPicked(ids)`, `setLit(ids)`, `setHidden(id)` | Outline holds; keep some bright and dim the rest; hide one (being moved) |
| `setHeat(colors)` | The Stats tab's usage colors (`Map` of hold id → color), or `null` |
| `setMode(mode)` | `'view'`, `'pick'` (taps pick holds) or `'place'` (presses go to `onWallPointer`) |
| `setDraft(d)`, `setVolumeDraft(d)`, `setHiddenVolume(id)`, `highlightVolume(id)` | The Wall tab's hold and volume being edited |
| `isZoomed()`, `zoomIn()`, `zoomOut()`, `resetZoom(animate)` | The zoom |
| `reset({ keepRoute })` | Back to the plain wall: `app.js` calls it between pages |
| `swipeLayer` | What a swipe between climbs slides |

On touch screens (`TOUCH` in `ui.js`; `LIGHT` in `board.js`) the holds are drawn from ready-made images and one server-made picture instead of SVG filters, which phones redraw slowly. Check a board change on a phone-sized touch screen as well as a computer.

## Tests

```sh
.venv/bin/python -m unittest discover tests                     # everything
.venv/bin/python -m unittest tests.test_holds                   # one file
.venv/bin/python -m unittest tests.test_holds.HoldApiTest.test_upload_off_grid_hold
```

The pre-push hook (`.githooks/pre-push`, turned on by `deploy/mac/install.sh`) runs them all before every push, and the Pi runs them again on each commit before deploying it.

`tests/support.py` has what the tests share. `ApiTestCase` gives each test its own app on a fresh database and upload folder, deleted afterwards, with `self.client`, `self.call(method, url, data, status)` (checks the status, returns the JSON), `self.add_holds([(name, col, row)])` and `self.make_admin()`. `ScratchTestCase` is just the temporary folder, for migration tests that build an old database themselves. Import `support` first in a test file, as it puts the app on the import path.

The tests cover the server. The browser has none of its own, so after a change there, click through the pages it touches, on a computer and on a phone-sized touch screen. Chrome's device toolbar does for the phone.

## API reference

Every call takes and returns JSON. An error is `{"error": "…"}` with status 400 (bad input), 401 (log in as the admin), 404, or 413 (image too large). `api.js` has a function for each one the app uses. **Admin** calls need the admin logged in.

**Board and holds** (`holds.py`, `hold_images.py`)

| | |
|---|---|
| `GET /api/board` | The wall's measurements and t-nut grid |
| `GET /api/hold-names` | `{letter: [nouns]}` |
| `GET /api/holds?ppi=` | Every hold, removed ones included; `ppi` sizes `board_url` for the screen |
| `POST /api/holds` | A new hold: multipart form with `image` (PNG), `x`, `y`, and optionally `size`, `rotation`, `color`, `name` |
| `PUT /api/holds/<id>` | Changes a hold (form or JSON); a new `image` replaces the old one |
| `GET /api/holds/<id>/impact` | The climbs that use it, and which would go to Legacy if it were removed |
| `DELETE /api/holds/<id>` | Removes it from the wall (restorable); answers with its impact |
| `POST /api/holds/<id>/restore` | Puts a removed hold back |
| `DELETE /api/holds/<id>/permanent` | Deletes a removed hold and its image, once no climb uses it |
| `PUT /api/holds/color` | `{hold_ids, color}`: one color for many holds (`null` for their own) |
| `GET /api/holds/picture?ppi=&border=&tint=` | The touch screens' picture of every hold, and the bolt holes under them |
| `GET /uploads/holds/<file>`, `/uploads/holds/board/<file>` | The images; board copies are made on first request |
| `GET, POST /api/colors`; `PUT, DELETE /api/colors/<id>` | The color list. Changing a hex recolors its holds; a color in use can't be deleted |
| `GET, POST /api/volumes`; `PUT, DELETE /api/volumes/<id>` | Volumes: `{points, color, faces}` |

**Climbs** (`climbs.py`)

| | |
|---|---|
| `GET /api/routes` | The climb list as families. Query: `q`, `scope` (`all`, `name`, `setter`, `fa`), `grade` (comma-separated), `hold_id`, `hide_sent_by`, `legacy=1`, `sort` (`set_date`, `grade`, `fa_date`, `ascents`, `sends`), `dir` (`asc`, `desc`), `me` |
| `GET /api/routes/<id>?me=` | One climb with its family, ascents, circuits and `me`'s history on it |
| `POST /api/routes` | A new climb: `name`, `grade`, `set_date`, `holds`, and optionally `parent_id`, `setter_id`, `notes`, `fa_climber_id` with `fa_date`, `draft_id` (publishing that draft deletes it) |
| `PUT /api/routes/<id>`; `DELETE /api/routes/<id>` | Changes or deletes a climb |
| `POST /api/routes/<id>/draft` | Moves an unsent climb back to Drafts |
| `GET, POST /api/drafts`; `GET, PUT, DELETE /api/drafts/<id>` | Drafts: the Set boulder form's fields and holds; name and set date may be blank |

**Climbers and the logbook** (`logbook.py`)

| | |
|---|---|
| `GET, POST /api/climbers` | Climbers (the admin is flagged); adding an existing name returns that climber |
| `GET /api/climbers/<id>/sends` | Their sends (with repeats and first ascents marked), tries, and totals |
| `GET /api/climbers/<id>/days` | `{days: {date: {sends, tries, outdoor, workout, fingers?}}}` for the calendars |
| `POST /api/sends`; `PUT, DELETE /api/sends/<id>` | Sends: `route_id`, `climber_id`, `sent_date`, `comment`. The first send of a climb becomes its first ascent |
| `POST /api/tries`; `PUT, DELETE /api/tries/<id>` | One "tried" mark per climb, climber and day: `route_id`, `climber_id`, `tried_date`, `note` |

Logging sends and tries *as the admin* needs the admin logged in.

**Circuits** (`circuits.py`). Each takes `?me=` and answers with the whole circuit.

| | |
|---|---|
| `GET, POST /api/circuits`; `GET, PUT, DELETE /api/circuits/<id>` | Circuits: `name`, `route_ids` (in order), `created_by` |
| `POST /api/circuits/<id>/routes`; `DELETE /api/circuits/<id>/routes/<route_id>` | Adds a climb at the end; takes one out |

**The admin login** (`auth.py`)

| | |
|---|---|
| `GET /api/session` | `{admin, admin_climber_id}` |
| `POST /api/login` | `{password}` |
| `POST /api/logout` | |

**Outdoors** (`outdoor.py`, admin)

| | |
|---|---|
| `GET, POST /api/outdoor/sessions`; `GET, PUT, DELETE /api/outdoor/sessions/<id>` | A day out: `session_date`, `area`, `notes`, `entries` (`{climb_id}` or `{climb: {name, area, grade}}`, with `sent` and `note`) |
| `GET, POST /api/outdoor/climbs`; `GET, PUT, DELETE /api/outdoor/climbs/<id>` | Outdoor climbs; one climb's page includes its `history` |

**Workouts** (`workouts.py`, admin)

| | |
|---|---|
| `GET, PUT, DELETE /api/workouts/<date>` | A day's workout with each exercise's sets, its last time and 30-day best; `PUT` sets `tiredness` and `notes` |
| `POST /api/workouts/<date>/exercises`; `DELETE /api/workout-exercises/<id>` | Adds an exercise (and variant) to the day; takes one out |
| `POST /api/workout-exercises/<id>/sets`; `PUT, DELETE /api/sets/<id>` | Sets: `reps`, `weight`, `seconds`, `edge_mm`, as the exercise's kind uses them |
| `GET, POST /api/exercises`; `PUT, DELETE /api/exercises/<id>` | Exercises and their variants |
| `POST /api/exercises/<id>/variants`; `PUT, DELETE /api/variants/<id>` | Variants |
| `GET /api/exercises/<id>/progress` | A series per variant, and every session's sets |

**Finger checks** (`fingers.py`, admin)

| | |
|---|---|
| `GET /api/fingers` | Every check, newest first |
| `GET /api/fingers/<date>` | That day's `start` and `end`, and the `previous` check |
| `PUT, DELETE /api/fingers/<date>/<phase>` | A check (`start` or `end`): `{scores: [10 numbers from 0 to 10], comment}` |
