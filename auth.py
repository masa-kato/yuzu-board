"""The admin login. One climber can be the admin (`python app.py --set-admin
<name>`), and choosing them in the app asks for their password, once per
device: the login cookie lasts a year. Only the admin sees the Outdoors and
Workout tabs and the finger checks (outdoor.py, workouts.py, fingers.py),
and only they can log sends and tries as themselves (logbook.py).
Everything else stays open to everyone. Until an admin is set, nobody needs
a password."""

import datetime
import functools
import hashlib
import secrets
import time

from flask import Blueprint, g, jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash

import db
from helpers import bad_request, error

bp = Blueprint("auth", __name__)

SESSION_DAYS = 365
WRONG_PASSWORD_DELAY = 1.0   # seconds before a wrong password is answered, to slow guessing
PASSWORD_MIN = 4
# Not Werkzeug's default, scrypt, which some Pythons' hashlib lacks (macOS's 3.9).
PASSWORD_METHOD = "pbkdf2:sha256:600000"


def get_setting(conn, key):
    r = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return r["value"] if r else None


def set_setting(conn, key, value):
    conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) "
                 "ON CONFLICT (key) DO UPDATE SET value = excluded.value", (key, value))


def init_app(app, conn):
    """Signs cookies with the database's own key and adds the login routes."""
    key = get_setting(conn, "secret_key")
    if key is None:
        key = secrets.token_hex(32)
        set_setting(conn, "secret_key", key)
        conn.commit()
    app.secret_key = key
    app.config.update(
        PERMANENT_SESSION_LIFETIME=datetime.timedelta(days=SESSION_DAYS),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
    )
    app.register_blueprint(bp)


def set_admin(conn, name, password):
    """Makes the climber called `name` (added if new) the admin, with this
    password. Devices logged in with an older password are logged out."""
    name = name.strip()
    if not name:
        raise ValueError("The admin needs a name")
    if len(password) < PASSWORD_MIN:
        raise ValueError("The password needs at least %d characters" % PASSWORD_MIN)
    climber = conn.execute("SELECT id FROM climbers WHERE name = ?", (name,)).fetchone()
    climber_id = climber["id"] if climber else conn.execute("INSERT INTO climbers (name) VALUES (?)", (name,)).lastrowid
    set_setting(conn, "admin_climber_id", str(climber_id))
    set_setting(conn, "admin_password_hash", generate_password_hash(password, method=PASSWORD_METHOD))
    conn.commit()
    return climber_id


def admin(conn):
    """{id, name, stamp} of the admin, or None. `stamp` changes with the
    password, so a cookie from before a new password no longer counts."""
    climber_id = get_setting(conn, "admin_climber_id")
    password_hash = get_setting(conn, "admin_password_hash")
    if climber_id is None or password_hash is None:
        return None
    climber = db.row(conn.execute("SELECT id, name FROM climbers WHERE id = ?", (int(climber_id),)))
    if climber is None:
        return None
    climber["stamp"] = hashlib.sha256(password_hash.encode()).hexdigest()[:16]
    climber["password_hash"] = password_hash
    return climber


def current_admin():
    """The admin for this request (looked up once)."""
    if "admin" not in g:
        g.admin = admin(db.get_db())
    return g.admin


def admin_climber_id():
    a = current_admin()
    return a["id"] if a else None


def is_admin():
    a = current_admin()
    return a is not None and session.get("admin") == a["stamp"]


def admin_required(view):
    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        if not is_admin():
            error("Log in as the admin first", 401)
        return view(*args, **kwargs)
    return wrapped


def guard_climber(climber_id):
    """Only the admin, logged in, can log climbing as the admin."""
    a = current_admin()
    if a is not None and climber_id == a["id"] and not is_admin():
        error("Log in as %s first" % a["name"], 401)


def session_state():
    return {"admin": is_admin(), "admin_climber_id": admin_climber_id()}


@bp.get("/api/session")
def get_session():
    return jsonify(session_state())


@bp.post("/api/login")
def login():
    a = current_admin()
    if a is None:
        bad_request("No admin has been set up")
    password = (request.get_json(silent=True) or {}).get("password")
    if not isinstance(password, str) or not check_password_hash(a["password_hash"], password):
        time.sleep(WRONG_PASSWORD_DELAY)
        error("Wrong password", 401)
    session.clear()
    session.permanent = True
    session["admin"] = a["stamp"]
    return jsonify(session_state())


@bp.post("/api/logout")
def logout():
    session.clear()
    return jsonify(session_state())
