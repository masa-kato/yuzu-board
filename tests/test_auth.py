import unittest

from support import ApiTestCase

import auth
import db


class AuthTest(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.add_holds([("Falcon", 5, 10)])
        self.alex = self.call("post", "/api/climbers", {"name": "Alex"})["id"]
        self.route = self.call("post", "/api/routes", {
            "name": "Slab", "grade": "easy", "set_date": "2026-09-01", "holds": [{"hold_id": 1, "role": "start"}],
        })["id"]

    def set_admin(self, name="Masa", password="hangboard"):
        return self.make_admin(name, password, log_in=False)

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
