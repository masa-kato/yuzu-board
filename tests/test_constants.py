"""The browser and schema.sql keep their own copies of some server values (the
grades, the hold roles, exercise kinds, name limits): these tests fail when a
copy drifts from the server's."""

import os
import re
import unittest

from support import ROOT

import circuits
import constants
import fingers
import hold_images
import outdoor
import workouts


def read(*parts):
    with open(os.path.join(ROOT, *parts)) as f:
        return f.read()


def js_const(source, name):
    """The text of `const NAME = …;` (exported or not) in a JS file."""
    match = re.search(r"const %s = (.*?);\n" % name, source, re.S)
    if match is None:
        raise AssertionError("no const %s" % name)
    return match.group(1)


def js_number(source, name):
    return float(re.search(r"const %s = (-?[\d.]+)" % name, source).group(1))


def quoted(text):
    return tuple(re.findall(r"'([^']*)'", text))


def keys(text):
    """The keys of a JS object literal, in order."""
    return tuple(re.findall(r"^\s+(\w+): ", text, re.M))


def checks(sql, column):
    """The value lists of every `CHECK (column IN (…))` in the schema."""
    return [quoted(values) for values in re.findall(r"CHECK \(%s IN \(([^)]*)\)\)" % column, sql)]


class ConstantsTest(unittest.TestCase):
    def setUp(self):
        self.schema = read("schema.sql")
        self.ui = read("static", "js", "ui.js")
        self.board = read("static", "js", "board.js")
        self.workout = read("static", "js", "views", "workout.js")

    def test_grades(self):
        self.assertEqual(quoted(js_const(self.ui, "GRADES")), constants.GRADES)
        self.assertEqual(tuple(re.findall(r"(\w+): \d", js_const(self.ui, "GRADE_LEVEL"))), constants.GRADES)
        self.assertEqual(checks(self.schema, "grade"), [constants.GRADES] * 2)   # routes, drafts

    def test_roles(self):
        self.assertEqual(quoted(js_const(self.ui, "ROLES")), constants.ROLES)
        self.assertEqual(keys(js_const(self.board, "RING_BANDS")), constants.ROLES)
        self.assertEqual(checks(self.schema, "role"), [constants.ROLES] * 2)     # route_holds, draft_holds

    def test_exercise_kinds(self):
        self.assertEqual(keys(js_const(self.workout, "KINDS")), workouts.KINDS)
        self.assertEqual(checks(self.schema, "kind"), [workouts.KINDS])
        columns = js_const(self.workout, "COLUMNS")
        for kind, fields in workouts.KIND_FIELDS.items():
            row = re.search(r"^\s+%s: (\[.*\]),$" % kind, columns, re.M).group(1)
            self.assertEqual(tuple(re.findall(r"\['(\w+)'", row)), fields, kind)

    def test_fingers(self):
        names = quoted(js_const(read("static", "js", "hands.js"), "FINGER_NAMES"))
        self.assertEqual(tuple(n.lower() for n in names), fingers.FINGERS)

    def test_limits(self):
        number = lambda path, name: js_number(read(*path), name)
        self.assertEqual(number(("static", "js", "views", "shared.js"), "CIRCUIT_NAME_MAX"), circuits.CIRCUIT_NAME_MAX)
        self.assertEqual(number(("static", "js", "views", "workout.js"), "NAME_MAX"), workouts.NAME_MAX)
        self.assertEqual(number(("static", "js", "views", "outdoor.js"), "NAME_MAX"), outdoor.NAME_MAX)
        self.assertEqual(number(("static", "js", "board.js"), "BORDER_OPACITY"), hold_images.BOARD_BORDER_OPACITY)
        self.assertEqual(tuple(int(v) for v in re.findall(r"\d+", js_const(self.board, "PICTURE_PPI"))),
                         hold_images.PICTURE_PPI)


if __name__ == "__main__":
    unittest.main()
