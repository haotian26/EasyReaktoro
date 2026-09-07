#!/usr/bin/env python3
"""Thin NDJSON entrypoint; implementation lives in easyreaktoro_runtime."""
from __future__ import annotations

import json
import sys

from easyreaktoro_runtime.service import dispatch


def main() -> None:
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("request_id")
            response = dispatch(request)
        except Exception as exc:
            response = {"ok": False, "error": {"code": "PROTOCOL_ERROR", "diagnostic": str(exc), "message_key": "error.protocol"}}
        response["request_id"] = request_id
        print(json.dumps(response, ensure_ascii=False, default=str), flush=True)


if __name__ == "__main__":
    main()
