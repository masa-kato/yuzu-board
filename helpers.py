"""Request helpers shared by app.py and its blueprints (auth, outdoor,
workouts): JSON errors and the parsing of submitted values."""

import datetime
import math

from flask import abort, jsonify


def error(message, status):
    response = jsonify({"error": message})
    response.status_code = status
    abort(response)


def bad_request(message):
    error(message, 400)


def not_found(what="Not found"):
    error(what, 404)


def parse_date(value, field):
    if not value:
        bad_request("%s is required" % field)
    try:
        return datetime.date.fromisoformat(str(value)).isoformat()
    except ValueError:
        bad_request("%s must be a date like 2026-10-22" % field)


def optional_int(value):
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        bad_request("Expected a number, got %r" % (value,))


def parse_float(value, field, lo, hi):
    try:
        number = float(value)
    except (TypeError, ValueError):
        bad_request("%s must be a number" % field)
    if math.isnan(number) or not lo <= number <= hi:
        bad_request("%s must be between %g and %g" % (field, lo, hi))
    return number


def text(data, key, field, max_length=None):
    """data[key] stripped, or '' when it's missing or null."""
    value = data.get(key)
    if value is None:
        return ""
    if not isinstance(value, str):
        bad_request("%s must be text" % field)
    value = value.strip()
    if max_length and len(value) > max_length:
        bad_request("%s is too long (%d characters max)" % (field, max_length))
    return value
