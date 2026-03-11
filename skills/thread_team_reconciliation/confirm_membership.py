#!/usr/bin/env python3
"""Minimal helper to verify expected membership state from JSON rows."""

import json
import sys


def main() -> int:
    payload = json.load(sys.stdin)
    target = str(payload.get("target_agent_id", "")).strip().lower()
    expect_present = bool(payload.get("expected_present", True))
    expect_enabled = bool(payload.get("expected_enabled", True))
    rows = payload.get("rows", [])

    found = None
    for row in rows:
        agent_id = str(row.get("agent_id", "")).strip().lower()
        if agent_id == target:
            found = row
            break

    if expect_present and not found:
        print("fail: target missing")
        return 1
    if (not expect_present) and found:
        print("fail: target unexpectedly present")
        return 1
    if found and bool(found.get("enabled", True)) != expect_enabled:
        print("fail: enabled mismatch")
        return 1

    print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
