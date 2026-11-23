"""The Yuzu Board's Flask app and its command line. The API lives in the
blueprints registered below (docs/development.md has the map)."""

import argparse
import getpass
import os

from flask import Flask, jsonify, send_from_directory

import auth
import circuits
import climbs
import db
import fingers
import hold_images
import holds
import logbook
import outdoor
import seed
import workouts

HERE = os.path.dirname(os.path.abspath(__file__))
BLUEPRINTS = (hold_images.bp, holds.bp, climbs.bp, logbook.bp, circuits.bp, outdoor.bp, workouts.bp, fingers.bp)
# Hosts only this computer can reach, where --debug's interactive debugger is safe.
LOOPBACK = {"127.0.0.1", "localhost", "::1"}


def create_app(db_path=None, upload_dir=None):
    app = Flask(__name__, static_folder=os.path.join(HERE, "static"), static_url_path="")
    app.config["DATABASE"] = db_path or db.DEFAULT_DB_PATH
    app.config["UPLOAD_DIR"] = upload_dir or hold_images.DEFAULT_UPLOAD_DIR
    app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024
    app.json.ensure_ascii = False
    app.teardown_appcontext(db.close_db)

    conn = db.connect(app.config["DATABASE"])
    db.init_db(conn)
    auth.init_app(app, conn)
    conn.close()
    for bp in BLUEPRINTS:
        app.register_blueprint(bp)

    @app.errorhandler(413)
    def too_large(_exc):
        return jsonify({"error": "That image is too large (8 MB max)"}), 413

    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    return app


def set_admin(db_path, name):
    password = getpass.getpass("Password for %s: " % name)
    if getpass.getpass("Again: ") != password:
        raise SystemExit("The passwords don't match.")
    conn = db.connect(db_path)
    try:
        auth.set_admin(conn, name, password)
    except ValueError as exc:
        raise SystemExit(str(exc))
    finally:
        conn.close()
    print("%s is the admin. Choosing %s in the app now asks for this password." % (name.strip(), name.strip()))


def listen_host(host, debug):
    """Where the server listens: `host` if given, else every network so
    phones can reach it. With --debug, whose debugger runs any code it's
    sent, it's only this computer unless `host` says otherwise."""
    return host or ("127.0.0.1" if debug else "0.0.0.0")


def main():
    parser = argparse.ArgumentParser(description="The Yuzu Board: a home bouldering wall route tracker")
    parser.add_argument("--host", help="address to listen on (default: 0.0.0.0, every network; "
                                       "127.0.0.1 with --debug)")
    parser.add_argument("--port", type=int, default=5050)
    parser.add_argument("--db", default=db.DEFAULT_DB_PATH)
    parser.add_argument("--uploads", help="folder for hold images (default: uploads/holds)")
    parser.add_argument("--debug", action="store_true",
                        help="reload on code changes and show tracebacks; only this computer can connect")
    parser.add_argument("--set-admin", metavar="NAME",
                        help="make this climber the admin, asking for their password, then exit")
    args = parser.parse_args()

    app = create_app(args.db, args.uploads)
    # Demo data goes only into a database nobody has used yet, never into one
    # whose wall has just been cleared.
    conn = db.connect(args.db)
    try:
        blank = seed.is_blank(conn)
    finally:
        conn.close()
    if blank and seed.seed(args.db):
        print("Seeded demo holds, routes and sends.")
    if args.set_admin:
        set_admin(args.db, args.set_admin)
        return

    host = listen_host(args.host, args.debug)
    if args.debug and host not in LOOPBACK:
        print("Warning: --debug on %s lets anyone who can reach it run code on this computer." % host)
    app.run(host=host, port=args.port, debug=args.debug)


if __name__ == "__main__":
    main()
