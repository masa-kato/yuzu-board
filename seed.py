"""Demo data: proxy holds at random t-nuts plus a handful of routes, sends and a circuit.

    python seed.py            # seed an empty database
    python seed.py --reset    # wipe homewall.db and reseed
"""
import argparse
import datetime
import math
import os
import random

import db
import geometry
import hold_names
from app import recompute_fa

MIN_GRID_DISTANCE = 2.5   # in t-nut spacings, keeps the demo board readable
CLIMBERS = ["Alex", "Sam", "Jordan"]
# (first row, last row, hold count): finishes up top, denser starts and feet below.
HOLD_BANDS = [(0, 5, 10), (6, 23, 20), (24, 38, 26)]


def place_holds(rng):
    """Pick random t-nuts, rejecting any too close to one already chosen."""
    chosen = []
    for first_row, last_row, count in HOLD_BANDS:
        placed = attempts = 0
        while placed < count and attempts < 5000:
            attempts += 1
            col = rng.randrange(geometry.COLS)
            row = rng.randint(first_row, last_row)
            if all(math.hypot(col - c, row - r) >= MIN_GRID_DISTANCE for c, r in chosen):
                chosen.append((col, row))
                placed += 1
    return chosen


class RouteBuilder:
    def __init__(self, rng, holds):
        self.rng = rng
        self.holds = holds   # [(hold_id, col, row)]

    def near(self, col, rows, used, spread=6):
        lo, hi = rows
        options = [h for h in self.holds if lo <= h[2] <= hi and abs(h[1] - col) <= spread and h[0] not in used]
        options.sort(key=lambda h: abs(h[1] - col) + self.rng.random() * 2)
        return options

    def build(self, start_col, finish_col, hand_count=4, two_starts=False):
        used, holds = set(), []

        def take(hold, role):
            used.add(hold[0])
            holds.append({"hold_id": hold[0], "role": role, "col": hold[1], "row": hold[2]})

        starts = self.near(start_col, (25, 33), used)
        take(starts[0], "start")
        if two_starts:
            second = [h for h in self.near(start_col, (24, 34), used) if abs(h[2] - starts[0][2]) <= 4]
            if second:
                take(second[0], "start")
        start_row = min(h["row"] for h in holds)

        finish = self.near(finish_col, (0, 5), used, spread=8)[0]
        take(finish, "finish")

        # Hand holds roughly along the line from start to finish.
        for i in range(1, hand_count + 1):
            t = i / float(hand_count + 1)
            row = start_row + (finish[2] - start_row) * t
            col = start_col + (finish_col - start_col) * t
            options = (self.near(round(col), (int(row) - 3, int(row) + 3), used, spread=5)
                       or self.near(round(col), (int(row) - 5, int(row) + 5), used, spread=9))
            if options:
                take(options[0], "hand")

        # Feet below the start.
        for foot in self.near(start_col, (start_row + 3, geometry.ROWS - 1), used, spread=7)[:3]:
            take(foot, "foot")
        return holds


ROUTES = [
    # name, grade, setter, days ago set, start col, finish col, hands, two starts
    ("Crimson Gecko", "easy", "Alex", 80, 8, 10, 4, True),
    ("Quiet Riot", "medium", "Sam", 64, 20, 26, 4, False),
    ("Velvet Undertow", "hard", "Jordan", 51, 30, 18, 3, True),
    ("Plywood Prophet", "medium", "Sam", 37, 14, 6, 4, False),
    ("Morning Fog", "easy", "Jordan", 22, 25, 33, 5, True),
    ("Gravity Tax", "project", "Alex", 9, 34, 36, 3, False),
    ("Lazy Sunday", "easy", "Alex", 4, 4, 2, 5, True),
]

VARIATIONS = [
    # parent, name, grade, setter, days ago set
    ("Crimson Gecko", "Sit Start", "medium", "Sam", 70),
    ("Velvet Undertow", "Left Exit", "project", "Jordan", 30),
    ("Velvet Undertow", "Big Moves", "hard", "Alex", 15),
]

SENDS = [
    # route display name, climber, days ago, comment
    ("Crimson Gecko", "Alex", 79, "Flowy warm-up."),
    ("Crimson Gecko", "Sam", 75, ""),
    ("Crimson Gecko", "Alex", 60, "Repeat for warm-up, felt easy."),
    ("Crimson Gecko", "Jordan", 40, "Nice movement on the second hand."),
    ("Crimson Gecko", "Alex", 12, ""),
    ("Crimson Gecko — Sit Start", "Sam", 68, "The sit adds a sneaky hard move."),
    ("Quiet Riot", "Jordan", 60, "Took a few sessions."),
    ("Quiet Riot", "Sam", 58, ""),
    ("Quiet Riot", "Jordan", 20, "Way smoother this time."),
    ("Velvet Undertow", "Alex", 44, "Crux is the third hand. Heel hook helps."),
    ("Velvet Undertow — Big Moves", "Jordan", 10, "Dyno to the finish!"),
    ("Plywood Prophet", "Alex", 33, ""),
    ("Plywood Prophet", "Jordan", 30, "Pinch is spicy."),
    ("Morning Fog", "Sam", 21, "Quick flash."),
    ("Morning Fog", "Alex", 18, ""),
    ("Morning Fog", "Sam", 6, "Repeat with no matching."),
    ("Lazy Sunday", "Jordan", 3, "Good kids' climb."),
]

# name, creator, climbs in order (route display names)
CIRCUITS = [
    ("Warm-up circuit", "Alex", ["Lazy Sunday", "Crimson Gecko", "Morning Fog", "Plywood Prophet"]),
]


def seed(db_path, reset=False):
    if reset and os.path.exists(db_path):
        os.remove(db_path)
    conn = db.connect(db_path)
    db.init_db(conn)
    if conn.execute("SELECT COUNT(*) FROM holds").fetchone()[0]:
        conn.close()
        return False

    rng = random.Random(2026)
    today = datetime.date.today()

    def days_ago(n):
        return (today - datetime.timedelta(days=n)).isoformat()

    climber_ids = {}
    for name in CLIMBERS:
        climber_ids[name] = conn.execute("INSERT INTO climbers (name) VALUES (?)", (name,)).lastrowid

    holds, names = [], set()
    for col, row in place_holds(rng):
        x, y = geometry.tnut_xy(col, row)
        name = hold_names.suggest_name(names, geometry.name_letter(col), rng=rng)
        names.add(name)
        hold_id = conn.execute(
            "INSERT INTO holds (name, x, y, tnut_col, tnut_row) VALUES (?, ?, ?, ?, ?)", (name, x, y, col, row)
        ).lastrowid
        holds.append((hold_id, col, row))

    builder = RouteBuilder(rng, holds)
    route_ids, route_holds = {}, {}

    def insert_route(name, grade, setter, set_days_ago, hold_list, parent_id=None):
        route_id = conn.execute(
            "INSERT INTO routes (name, parent_id, grade, setter_id, set_date) VALUES (?, ?, ?, ?, ?)",
            (name, parent_id, grade, climber_ids[setter], days_ago(set_days_ago)),
        ).lastrowid
        conn.executemany(
            "INSERT INTO route_holds (route_id, hold_id, role) VALUES (?, ?, ?)",
            [(route_id, h["hold_id"], h["role"]) for h in hold_list],
        )
        return route_id

    for name, grade, setter, ago, start_col, finish_col, hands, two_starts in ROUTES:
        hold_list = builder.build(start_col, finish_col, hands, two_starts)
        route_ids[name] = insert_route(name, grade, setter, ago, hold_list)
        route_holds[name] = hold_list

    for parent, name, grade, setter, ago in VARIATIONS:
        hold_list = [dict(h) for h in route_holds[parent]]
        used = {h["hold_id"] for h in hold_list}
        starts = [h for h in hold_list if h["role"] == "start"]
        if name == "Sit Start":
            # Old starts become hand holds; start lower down instead.
            low_row = max(h["row"] for h in starts)
            # One of the parent's foot holds may get promoted to the sit start.
            feet = {h["hold_id"] for h in hold_list if h["role"] == "foot"}
            low = builder.near(starts[0]["col"], (low_row + 2, geometry.ROWS - 1), used - feet, spread=8)[0]
            for h in starts:
                h["role"] = "hand"
            hold_list = [h for h in hold_list if h["hold_id"] != low[0]]
            hold_list.append({"hold_id": low[0], "role": "start", "col": low[1], "row": low[2]})
        elif name == "Left Exit":
            # Columns count from the right, so a larger column is further left.
            finish = next(h for h in hold_list if h["role"] == "finish")
            exit_hold = builder.near(finish["col"] + 8, (0, 5), used, spread=6)[0]
            finish.update(hold_id=exit_hold[0], col=exit_hold[1], row=exit_hold[2])
        elif name == "Big Moves":
            hands = [h for h in hold_list if h["role"] == "hand"]
            hold_list.remove(hands[len(hands) // 2])
        route_ids["%s — %s" % (parent, name)] = insert_route(
            name, grade, setter, ago, hold_list, parent_id=route_ids[parent]
        )

    for route, climber, ago, comment in SENDS:
        conn.execute(
            "INSERT INTO sends (route_id, climber_id, sent_date, comment) VALUES (?, ?, ?, ?)",
            (route_ids[route], climber_ids[climber], days_ago(ago), comment),
        )
    for route_id in route_ids.values():
        recompute_fa(conn, route_id)

    for name, creator, routes in CIRCUITS:
        circuit_id = conn.execute(
            "INSERT INTO circuits (name, created_by) VALUES (?, ?)", (name, climber_ids[creator])
        ).lastrowid
        conn.executemany(
            "INSERT INTO circuit_routes (circuit_id, route_id, position) VALUES (?, ?, ?)",
            [(circuit_id, route_ids[route], i) for i, route in enumerate(routes)],
        )

    conn.commit()
    conn.close()
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--reset", action="store_true", help="delete the database first")
    parser.add_argument("--db", default=db.DEFAULT_DB_PATH)
    args = parser.parse_args()
    if seed(args.db, reset=args.reset):
        print("Seeded %s" % args.db)
    else:
        print("Database already has holds; use --reset to start over.")
