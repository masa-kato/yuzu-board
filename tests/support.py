"""What the tests share: the app's folder on the import path (so a test file
imports this first); ScratchTestCase, a temporary folder for each test; and
ApiTestCase, which gives each test its own app on a fresh database and
upload folder in it. Both are deleted after the test."""

import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import auth  # noqa: E402
import db  # noqa: E402
import geometry  # noqa: E402
from app import create_app  # noqa: E402

ADMIN_PASSWORD = "hangboard"


class ScratchTestCase(unittest.TestCase):
    """A temporary folder for each test, `self.tmp`, deleted afterwards."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def scratch(self, name):
        """A path in the test's folder."""
        return os.path.join(self.tmp, name)


class ApiTestCase(ScratchTestCase):
    """A fresh app for each test, in its own folder. Passwords hash quickly
    and a wrong one is answered at once, only while the test runs."""

    def setUp(self):
        super().setUp()
        self.db_path = self.scratch("test.db")
        self.upload_dir = self.scratch("uploads")
        os.makedirs(self.upload_dir)
        for name, value in (("PASSWORD_METHOD", "pbkdf2:sha256:1000"), ("WRONG_PASSWORD_DELAY", 0)):
            patcher = mock.patch.object(auth, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.app = create_app(self.db_path, self.upload_dir)
        self.client = self.app.test_client()

    def call(self, method, url, data=None, status=None, client=None):
        """A JSON request. Checks the status (any success when none is given)
        and returns the JSON answer."""
        res = getattr(client or self.client, method)(url, json=data)
        if status is not None:
            self.assertEqual(res.status_code, status, res.get_json())
        else:
            self.assertLess(res.status_code, 300, res.get_json())
        return res.get_json()

    def add_holds(self, holds):
        """Placeholder holds written straight to the database: (name, col, row) at those t-nuts."""
        conn = db.connect(self.db_path)
        for name, col, row in holds:
            x, y = geometry.tnut_xy(col, row)
            conn.execute("INSERT INTO holds (name, x, y, tnut_col, tnut_row) VALUES (?, ?, ?, ?, ?)",
                         (name, x, y, col, row))
        conn.commit()
        conn.close()

    def make_admin(self, name="Masa", password=ADMIN_PASSWORD, log_in=True):
        """Makes `name` the admin (as --set-admin does); logs this client in unless told not to."""
        conn = db.connect(self.db_path)
        climber_id = auth.set_admin(conn, name, password)
        conn.close()
        if log_in:
            self.call("post", "/api/login", {"password": password})
        return climber_id
