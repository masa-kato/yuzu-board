# Lets `python -m unittest tests.test_holds` find support.py, as discovery
# (python -m unittest discover tests) does by itself.
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
