import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import db  # noqa: E402
import geometry  # noqa: E402
from app import create_app  # noqa: E402

OLD_CHECK = "CHECK (grade IN ('easy', 'medium', 'hard', 'project'))"


class WarmupTest(unittest.TestCase):
    """Warm-up is a grade below Easy."""

    def setUp(self):
        fd, self.db_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.client = create_app(self.db_path, tempfile.mkdtemp()).test_client()

    def tearDown(self):
        os.remove(self.db_path)

    def call(self, method, url, data=None, status=None):
        res = getattr(self.client, method)(url, json=data)
        if status is not None:
            self.assertEqual(res.status_code, status, res.get_json())
        else:
            self.assertLess(res.status_code, 300, res.get_json())
        return res.get_json()

    def route(self, name, grade):
        return self.call("post", "/api/routes", {"name": name, "grade": grade, "set_date": "2026-09-01", "holds": []})["id"]

    def test_warmup_routes_and_drafts(self):
        warm = self.route("Warm Up", "warmup")
        self.route("Easy One", "easy")
        self.route("Hard One", "hard")
        self.assertEqual(self.call("get", "/api/routes/%d" % warm)["grade"], "warmup")
        self.assertEqual([r["name"] for r in self.call("get", "/api/routes?grade=warmup")], ["Warm Up"])
        self.assertEqual([r["name"] for r in self.call("get", "/api/routes?sort=grade&dir=asc")], ["Warm Up", "Easy One", "Hard One"])
        self.assertEqual([r["name"] for r in self.call("get", "/api/routes?sort=grade&dir=desc")], ["Hard One", "Easy One", "Warm Up"])
        draft = self.call("post", "/api/drafts", {"name": "", "grade": "warmup", "holds": []})
        self.assertEqual(draft["grade"], "warmup")
        self.call("post", "/api/routes", {"name": "Nope", "grade": "warm", "set_date": "2026-09-01", "holds": []}, status=400)


class GradeMigrationTest(unittest.TestCase):
    """A database from before Warm-up has `routes` and `drafts` tables whose
    CHECK lists four grades. Startup rebuilds them to take Warm-up, keeping
    every row, id and link."""

    def old_database(self, path):
        conn = db.connect(path)
        with open(db.SCHEMA_PATH) as f:
            schema = f.read()
        conn.executescript(schema.replace(db.GRADE_CHECK, OLD_CHECK))
        x, y = geometry.tnut_xy(5, 10)
        conn.executescript("""
            INSERT INTO climbers (id, name) VALUES (1, 'Alex'), (2, 'Sam');
            INSERT INTO holds (id, name, x, y, tnut_col, tnut_row) VALUES (1, 'Falcon', %r, %r, 5, 10);
            INSERT INTO routes (id, name, grade, setter_id, set_date) VALUES (7, 'Base', 'easy', 1, '2026-09-01');
            INSERT INTO routes (id, name, parent_id, grade, set_date) VALUES (9, 'Sit Start', 7, 'hard', '2026-09-02');
            INSERT INTO route_holds (route_id, hold_id, role) VALUES (7, 1, 'start'), (9, 1, 'finish');
            INSERT INTO sends (route_id, climber_id, sent_date) VALUES (7, 2, '2026-09-03'), (9, 2, '2026-09-04');
            INSERT INTO circuits (id, name, created_by) VALUES (3, 'Warmups', 1);
            INSERT INTO circuit_routes (circuit_id, route_id, position) VALUES (3, 7, 0), (3, 9, 1);
            INSERT INTO drafts (id, name, parent_id, grade) VALUES (4, 'Half done', 7, 'medium');
            INSERT INTO draft_holds (draft_id, hold_id, role) VALUES (4, 1, 'hand');
            INSERT INTO drafts (id, name, grade) VALUES (6, 'Published', 'easy');
            DELETE FROM drafts WHERE id = 6;
        """ % (x, y))
        conn.commit()
        self.assertIn(OLD_CHECK, conn.execute("SELECT sql FROM sqlite_master WHERE name = 'routes'").fetchone()["sql"])
        return conn

    def counts(self, conn):
        return {t: conn.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0]
                for t in ("routes", "route_holds", "sends", "circuit_routes", "drafts", "draft_holds")}

    def test_old_tables_take_warmup(self):
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        try:
            conn = self.old_database(path)
            before = self.counts(conn)
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute("INSERT INTO routes (name, grade, set_date) VALUES ('W', 'warmup', '2026-09-05')")
            conn.rollback()

            db.init_db(conn)
            self.assertEqual(self.counts(conn), before)
            for table in ("routes", "drafts"):
                sql = conn.execute("SELECT sql FROM sqlite_master WHERE name = ?", (table,)).fetchone()["sql"]
                self.assertIn(db.GRADE_CHECK, sql)
                self.assertTrue(sql.startswith("CREATE TABLE %s " % table) or sql.startswith('CREATE TABLE "%s"' % table), sql)
            self.assertEqual([tuple(r) for r in conn.execute("SELECT id, parent_id, grade FROM routes ORDER BY id")],
                             [(7, None, "easy"), (9, 7, "hard")])
            self.assertEqual(conn.execute("PRAGMA foreign_key_check").fetchall(), [])
            self.assertTrue(conn.execute("PRAGMA foreign_keys").fetchone()[0])
            self.assertIsNotNone(conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'idx_routes_parent'").fetchone())

            # Warm-up is accepted now, and a new draft doesn't reuse a published one's id.
            conn.execute("INSERT INTO routes (name, grade, set_date) VALUES ('W', 'warmup', '2026-09-05')")
            conn.execute("INSERT INTO drafts (name, grade) VALUES ('New', 'warmup')")
            self.assertEqual(conn.execute("SELECT MAX(id) FROM drafts").fetchone()[0], 7)
            conn.commit()

            # Links still cascade: deleting the base problem takes its variation,
            # their holds, sends and circuit places, and the draft hanging off it.
            conn.execute("DELETE FROM routes WHERE id = 7")
            conn.commit()
            after = self.counts(conn)
            self.assertEqual((after["routes"], after["route_holds"], after["sends"], after["circuit_routes"]), (1, 0, 0, 0))
            self.assertEqual([r["name"] for r in conn.execute("SELECT name FROM drafts")], ["New"])

            # A second start leaves the tables alone.
            sql = conn.execute("SELECT sql FROM sqlite_master WHERE name = 'routes'").fetchone()["sql"]
            db.init_db(conn)
            self.assertEqual(conn.execute("SELECT sql FROM sqlite_master WHERE name = 'routes'").fetchone()["sql"], sql)
            conn.close()
        finally:
            os.remove(path)


if __name__ == "__main__":
    unittest.main()
