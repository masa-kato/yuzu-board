import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import auth  # noqa: E402
import db  # noqa: E402
import geometry  # noqa: E402
from app import create_app  # noqa: E402


class AuthTest(unittest.TestCase):
    def setUp(self):
        fd, self.db_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.app = create_app(self.db_path, tempfile.mkdtemp())
        self.client = self.app.test_client()
        auth.WRONG_PASSWORD_DELAY = 0
        auth.PASSWORD_METHOD = "pbkdf2:sha256:1000"   # quick to check in tests
        conn = db.connect(self.db_path)
        x, y = geometry.tnut_xy(5, 10)
        conn.execute("INSERT INTO holds (name, x, y, tnut_col, tnut_row) VALUES ('Falcon', ?, ?, 5, 10)", (x, y))
        conn.commit()
        conn.close()
        self.alex = self.call("post", "/api/climbers", {"name": "Alex"})["id"]
        self.route = self.call("post", "/api/routes", {
            "name": "Slab", "grade": "easy", "set_date": "2026-09-01", "holds": [{"hold_id": 1, "role": "start"}],
        })["id"]

    def tearDown(self):
        os.remove(self.db_path)

    def call(self, method, url, data=None, status=None, client=None):
        res = getattr(client or self.client, method)(url, json=data)
        if status is not None:
            self.assertEqual(res.status_code, status, res.get_json())
        else:
            self.assertLess(res.status_code, 300, res.get_json())
        return res.get_json()

    def set_admin(self, name="Masa", password="hangboard"):
        conn = db.connect(self.db_path)
        climber_id = auth.set_admin(conn, name, password)
        conn.close()
        return climber_id

    def send(self, climber_id, status=201, client=None):
        return self.call("post", "/api/sends", {"route_id": self.route, "climber_id": climber_id, "sent_date": "2026-10-01"},
                         status, client)

    def test_without_an_admin_nothing_needs_a_password(self):
        self.assertEqual(self.call("get", "/api/session"), {"admin": False, "admin_climber_id": None})
        self.assertFalse(any(c["is_admin"] for c in self.call("get", "/api/climbers")))
        self.send(self.alex)
        self.call("post", "/api/login", {"password": "anything"}, 400)

    def test_set_admin_adds_the_climber_or_uses_the_existing_one(self):
        masa = self.set_admin("Masa")
        climbers = {c["name"]: c for c in self.call("get", "/api/climbers")}
        self.assertEqual(climbers["Masa"]["id"], masa)
        self.assertTrue(climbers["Masa"]["is_admin"])
        self.assertFalse(climbers["Alex"]["is_admin"])
        self.assertEqual(self.set_admin("alex"), self.alex)
        self.assertEqual(self.call("get", "/api/session")["admin_climber_id"], self.alex)

    def test_set_admin_needs_a_real_password(self):
        conn = db.connect(self.db_path)
        with self.assertRaises(ValueError):
            auth.set_admin(conn, "Masa", "abc")
        with self.assertRaises(ValueError):
            auth.set_admin(conn, "  ", "hangboard")
        conn.close()

    def test_login_and_logout(self):
        masa = self.set_admin()
        self.call("post", "/api/login", {"password": "wrong"}, 401)
        self.call("post", "/api/login", {}, 401)
        self.assertFalse(self.call("get", "/api/session")["admin"])
        self.assertEqual(self.call("post", "/api/login", {"password": "hangboard"}),
                         {"admin": True, "admin_climber_id": masa})
        self.assertTrue(self.call("get", "/api/session")["admin"])
        # The cookie is meant to last, so phones stay logged in.
        cookie = self.client.get_cookie("session")
        self.assertIsNotNone(cookie.expires)
        self.assertFalse(self.call("post", "/api/logout")["admin"])
        self.assertFalse(self.call("get", "/api/session")["admin"])

    def test_only_the_logged_in_admin_logs_sends_as_the_admin(self):
        masa = self.set_admin()
        self.send(masa, 401)
        self.send(self.alex)   # anyone else, as before
        self.call("post", "/api/login", {"password": "hangboard"})
        send = self.send(masa)["id"]
        other = self.app.test_client()
        self.call("put", "/api/sends/%d" % send, {"comment": "mine"}, 401, other)
        self.call("delete", "/api/sends/%d" % send, None, 401, other)
        alex_send = self.send(self.alex, client=other)["id"]
        self.call("put", "/api/sends/%d" % alex_send, {"climber_id": masa}, 401, other)
        self.call("put", "/api/sends/%d" % send, {"comment": "mine"})
        self.call("delete", "/api/sends/%d" % send)

    def test_a_new_password_logs_out_other_devices(self):
        self.set_admin()
        self.call("post", "/api/login", {"password": "hangboard"})
        self.set_admin(password="campusboard")
        self.assertFalse(self.call("get", "/api/session")["admin"])
        self.call("post", "/api/login", {"password": "hangboard"}, 401)
        self.call("post", "/api/login", {"password": "campusboard"})
        self.assertTrue(self.call("get", "/api/session")["admin"])


if __name__ == "__main__":
    unittest.main()
