import os
import unittest
from unittest import mock

from support import ScratchTestCase

import app
import auth
import db
import seed


class SeedTest(ScratchTestCase):
    def setUp(self):
        super().setUp()
        self.db_path = self.scratch("homewall.db")
        self.upload_dir = self.scratch("uploads")

    def blank(self):
        conn = db.connect(self.db_path)
        try:
            return seed.is_blank(conn)
        finally:
            conn.close()

    def count(self, table):
        conn = db.connect(self.db_path)
        try:
            return conn.execute("SELECT COUNT(*) FROM %s" % table).fetchone()[0]
        finally:
            conn.close()

    def test_a_new_database_is_seeded_once(self):
        app.create_app(self.db_path, self.upload_dir)
        self.assertTrue(self.blank())
        self.assertTrue(seed.seed(self.db_path))
        self.assertFalse(self.blank())
        holds = self.count("holds")
        self.assertGreater(holds, 0)
        self.assertFalse(seed.seed(self.db_path))
        self.assertEqual(self.count("holds"), holds)

    def test_a_cleared_wall_is_not_seeded_again(self):
        """Once every climb and hold is gone, the climbers are still there, so
        a restart neither adds the demo data nor trips over its climbers."""
        seed.seed(self.db_path)
        conn = db.connect(self.db_path)
        conn.execute("DELETE FROM routes")
        conn.execute("DELETE FROM holds")
        conn.commit()
        conn.close()
        self.assertFalse(self.blank())
        self.assertFalse(seed.seed(self.db_path))
        self.assertEqual((self.count("holds"), self.count("routes")), (0, 0))

    def test_set_admin_first_still_seeds_without_a_clash(self):
        """--set-admin on a new database: main() seeds it first, so an admin
        called like a demo climber is that climber, not a second one."""
        seed.seed(self.db_path)
        conn = db.connect(self.db_path)
        alex = conn.execute("SELECT id FROM climbers WHERE name = 'Alex'").fetchone()[0]
        with mock.patch.object(auth, "PASSWORD_METHOD", "pbkdf2:sha256:1000"):
            self.assertEqual(auth.set_admin(conn, "alex", "hangboard"), alex)
        conn.close()

    def test_reset_clears_the_hold_images(self):
        seed.seed(self.db_path)
        image = "0123456789abcdef0123456789abcdef.png"
        os.makedirs(os.path.join(self.upload_dir, "board"))
        for name in (image, "keep-me.txt", os.path.join("board", "0123456789abcdef0123456789abcdef-96.png")):
            with open(os.path.join(self.upload_dir, name), "wb") as f:
                f.write(b"x")
        self.assertTrue(seed.seed(self.db_path, reset=True, upload_dir=self.upload_dir))
        self.assertEqual(os.listdir(self.upload_dir), ["keep-me.txt"])
        seed.seed(self.db_path, reset=True, upload_dir=self.scratch("no-such-folder"))   # nothing to clear


class ListenHostTest(unittest.TestCase):
    def test_debug_stays_on_this_computer(self):
        self.assertEqual(app.listen_host(None, False), "0.0.0.0")
        self.assertEqual(app.listen_host(None, True), "127.0.0.1")
        self.assertEqual(app.listen_host("0.0.0.0", True), "0.0.0.0")   # asked for, and warned about
        self.assertEqual(app.listen_host("192.168.1.5", False), "192.168.1.5")


if __name__ == "__main__":
    unittest.main()
