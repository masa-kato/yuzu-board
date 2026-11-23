"""Values the server modules share. The browser and schema.sql keep their own
copies (ui.js GRADES and ROLES, the CHECKs in schema.sql);
tests/test_constants.py fails if any of them drift apart."""

# Easiest first (sorting by grade goes by this order).
GRADES = ("warmup", "easy", "medium", "hard", "project")
ROLES = ("start", "hand", "foot", "finish")
