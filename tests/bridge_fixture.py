"""Synthetic NDJSON subprocess fixture; no chemistry or personal data."""
import json
import sys
import atexit
from pathlib import Path

for line in sys.stdin:
    request = json.loads(line)
    if request["op"] == "exit":
        break
    if request["op"] == "noisy":
        sys.stderr.write("diagnostic\n" * 20000)
        sys.stderr.flush()
    if request["op"] == "cleanup_marker":
        atexit.register(Path(request["path"]).write_text, "cleaned")
    print(json.dumps({"ok": True, "request_id": "wrong" if request["op"] == "wrong_id" else request["request_id"], "result": 42}), flush=True)
