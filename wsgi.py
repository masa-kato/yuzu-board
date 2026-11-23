"""The app for a production server: the Pi runs it with waitress
(deploy/pi/systemd/yuzu-board.service). YUZU_DB and YUZU_UPLOADS say where
its database and hold images are. The database must already exist, so a
wrong path never starts an empty wall."""

import os

from app import create_app

DB = os.environ.get("YUZU_DB", "")
if not os.path.isfile(DB) or os.path.getsize(DB) == 0:
    raise SystemExit("YUZU_DB must name the existing database, not %r" % DB)

app = create_app(DB, os.environ.get("YUZU_UPLOADS") or None)
