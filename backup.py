"""Snapshots of the database (docs/deploy.md): a sound copy taken while the
app runs, kept by age, and checked. Only the standard library, so the Pi's
timer and the Mac's sync job (deploy/mac/sync-from-pi.sh) both run it with
the system's Python.

    python3 backup.py snapshot DB DIR [--tag TAG]   copy DB into DIR as homewall-YYYYMMDD-HHMM[-TAG].db
    python3 backup.py prune DIR                     keep 48 hours of them, then a day's last, then a month's last
    python3 backup.py verify FILE                   fail unless FILE is a sound Yuzu Board database
    python3 backup.py latest DIR                    print the newest snapshot's path (nothing when there's none)
"""

import argparse
import datetime
import os
import re
import sqlite3
import sys
import time
from pathlib import Path

NAME_RE = re.compile(r"^homewall-(\d{8}-\d{4})(?:-[\w.-]+)?\.db$")
STAMP = "%Y%m%d-%H%M"
KEEP_EVERY = datetime.timedelta(hours=48)   # every snapshot this recent stays
KEEP_DAILY = datetime.timedelta(days=60)    # then each day's last, then each month's last
STALE_PART = 3600                           # seconds before a half-written copy is cleared away


def connect_read_only(path):
    return sqlite3.connect(Path(path).absolute().as_uri() + "?mode=ro", uri=True)


def check(path):
    """None for a sound Yuzu Board database, else what's wrong with it."""
    try:
        conn = connect_read_only(path)
        try:
            result = conn.execute("PRAGMA integrity_check").fetchone()[0]
            conn.execute("SELECT COUNT(*) FROM climbers").fetchone()   # the app's, not just any database
        finally:
            conn.close()
    except sqlite3.DatabaseError as exc:
        return str(exc)
    return None if result == "ok" else result


def snapshot(db_path, folder, tag=None, now=None):
    """Copies the database into `folder` with SQLite's backup API, which
    makes a sound copy even while the app writes, and returns its path. A
    copy that fails its check is removed and raises ValueError."""
    if not os.path.isfile(db_path):
        raise FileNotFoundError("No database at %s" % db_path)
    os.makedirs(folder, exist_ok=True)
    stamp = (now or datetime.datetime.now()).strftime(STAMP)
    path = os.path.join(folder, "homewall-%s%s.db" % (stamp, "-" + tag if tag else ""))
    part = path + ".part"
    src = connect_read_only(db_path)
    dst = sqlite3.connect(part)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    problem = check(part)
    if problem:
        os.remove(part)
        raise ValueError("The copy of %s isn't sound: %s" % (db_path, problem))
    os.replace(part, path)
    return path


def snapshots(folder):
    """[(when, name)] of the snapshots in `folder`, oldest first."""
    found = []
    for name in os.listdir(folder) if os.path.isdir(folder) else ():
        m = NAME_RE.match(name)
        if m:
            found.append((datetime.datetime.strptime(m.group(1), STAMP), name))
    return sorted(found)


def prune(folder, now=None):
    """Removes snapshots by age: every one from the last 48 hours stays, then
    the last of each day for 60 days, then the last of each month. Returns
    the names removed."""
    now = now or datetime.datetime.now()
    days, months, removed = set(), set(), []
    for when, name in reversed(snapshots(folder)):   # newest first, so a day's first seen is its last
        age = now - when
        keep = (age <= KEEP_EVERY
                or (age <= KEEP_DAILY and when.date() not in days)
                or (when.year, when.month) not in months)
        days.add(when.date())
        months.add((when.year, when.month))
        if not keep:
            os.remove(os.path.join(folder, name))
            removed.append(name)
    for name in os.listdir(folder) if os.path.isdir(folder) else ():
        path = os.path.join(folder, name)
        if name.endswith(".part") and time.time() - os.path.getmtime(path) > STALE_PART:
            os.remove(path)
    return removed


def latest(folder):
    """The newest snapshot's path, or None."""
    found = snapshots(folder)
    return os.path.join(folder, found[-1][1]) if found else None


def main(argv=None):
    parser = argparse.ArgumentParser(description="Snapshots of the Yuzu Board's database")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("snapshot", help="copy the database into a folder of snapshots")
    p.add_argument("db")
    p.add_argument("folder")
    p.add_argument("--tag", help="added to the name, e.g. pre-deploy-1a2b3c4")
    p = sub.add_parser("prune", help="remove snapshots by age")
    p.add_argument("folder")
    p = sub.add_parser("verify", help="fail unless a file is a sound database")
    p.add_argument("file")
    p = sub.add_parser("latest", help="print the newest snapshot's path")
    p.add_argument("folder")
    args = parser.parse_args(argv)

    if args.command == "snapshot":
        try:
            print(snapshot(args.db, args.folder, args.tag))
        except (OSError, ValueError, sqlite3.Error) as exc:
            raise SystemExit(str(exc))
    elif args.command == "prune":
        for name in prune(args.folder):
            print("removed", name)
    elif args.command == "verify":
        problem = check(args.file) if os.path.isfile(args.file) else "no such file"
        if problem:
            raise SystemExit("%s: %s" % (args.file, problem))
    elif args.command == "latest":
        path = latest(args.folder)
        if path:
            print(path)


if __name__ == "__main__":
    sys.exit(main())
