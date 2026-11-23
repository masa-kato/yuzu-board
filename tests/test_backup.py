import datetime
import os
import sqlite3

from support import ScratchTestCase

import backup
import db


class BackupTest(ScratchTestCase):
    def setUp(self):
        super().setUp()
        self.db_path = self.scratch("homewall.db")
        conn = db.connect(self.db_path)
        db.init_db(conn)
        conn.execute("INSERT INTO climbers (name) VALUES ('Alex')")
        conn.commit()
        conn.close()
        self.folder = self.scratch("backups")

    def names(self, path):
        conn = sqlite3.connect(path)
        try:
            return [r[0] for r in conn.execute("SELECT name FROM climbers ORDER BY id")]
        finally:
            conn.close()

    def test_a_snapshot_while_the_app_writes(self):
        writer = sqlite3.connect(self.db_path)
        writer.execute("INSERT INTO climbers (name) VALUES ('Sam')")   # not yet committed
        path = backup.snapshot(self.db_path, self.folder, tag="pre-deploy-1a2b3c4",
                               now=datetime.datetime(2026, 11, 22, 9, 5))
        writer.commit()
        writer.close()
        self.assertEqual(os.path.basename(path), "homewall-20261122-0905-pre-deploy-1a2b3c4.db")
        self.assertEqual(self.names(path), ["Alex"])
        self.assertIsNone(backup.check(path))
        self.assertEqual(os.listdir(self.folder), [os.path.basename(path)])   # no half-written copy left

    def test_no_database(self):
        with self.assertRaises(FileNotFoundError):
            backup.snapshot(self.scratch("missing.db"), self.folder)

    def test_prune_keeps_48_hours_then_days_then_months(self):
        now = datetime.datetime(2026, 11, 22, 12, 0)
        os.makedirs(self.folder)
        times = [
            now - datetime.timedelta(minutes=15 * i) for i in range(0, 200, 7)        # the last two days or so
        ] + [
            datetime.datetime(2026, 11, 10, h, 0) for h in (9, 15, 21)                # a day in the daily window
        ] + [
            datetime.datetime(2026, 8, d, 12, 0) for d in (3, 17, 28)                # a month past 60 days
        ] + [datetime.datetime(2026, 7, 31, 23, 45)]
        for t in times:
            open(os.path.join(self.folder, "homewall-%s.db" % t.strftime(backup.STAMP)), "w").close()
        open(os.path.join(self.folder, "notes.txt"), "w").close()

        removed = backup.prune(self.folder, now=now)
        kept = {when for when, _ in backup.snapshots(self.folder)}
        self.assertTrue(all(t in kept for t in times if now - t <= backup.KEEP_EVERY))
        self.assertEqual({t for t in kept if t.date() == datetime.date(2026, 11, 10)}, {datetime.datetime(2026, 11, 10, 21, 0)})
        self.assertEqual({t for t in kept if t.month == 8}, {datetime.datetime(2026, 8, 28, 12, 0)})
        self.assertIn(datetime.datetime(2026, 7, 31, 23, 45), kept)
        self.assertEqual(len(removed), 2 + 2 + len([t for t in times if datetime.timedelta(hours=48) < now - t < datetime.timedelta(days=3)]))
        self.assertTrue(os.path.exists(os.path.join(self.folder, "notes.txt")))   # only snapshots are touched
        self.assertEqual(backup.prune(self.folder, now=now), [])

    def test_unsound_files_fail_their_check(self):
        junk = self.scratch("junk.db")
        with open(junk, "wb") as f:
            f.write(os.urandom(4096))
        self.assertIsNotNone(backup.check(junk))
        other = self.scratch("other.db")
        sqlite3.connect(other).execute("CREATE TABLE t (x)").connection.close()
        self.assertIn("climbers", backup.check(other))
        self.assertIsNone(backup.check(self.db_path))
        with self.assertRaises(SystemExit):
            backup.main(["verify", junk])
        backup.main(["verify", self.db_path])

    def test_latest(self):
        self.assertIsNone(backup.latest(self.folder))
        first = backup.snapshot(self.db_path, self.folder, now=datetime.datetime(2026, 11, 21, 23, 45))
        self.assertEqual(backup.latest(self.folder), first)
        second = backup.snapshot(self.db_path, self.folder, now=datetime.datetime(2026, 11, 22, 0, 0))
        self.assertEqual(backup.latest(self.folder), second)
