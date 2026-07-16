import os
import tempfile

# Redirect sentiment history and reliability files to temporary locations
# before any backend modules are imported by tests.
os.environ["SENTIMENT_HISTORY_PATH"] = tempfile.mktemp()
os.environ["SENTIMENT_RELIABILITY_PATH"] = tempfile.mktemp()
