"""Make the bridge module importable and isolate every test from live state.

The bridge writes receipts and an arm-state file to disk, and a real bridge
process may be running against those same paths. The autouse fixture below
redirects both to a temp dir and resets in-memory state before each test, so
running this suite can never arm/disarm or perturb a live bridge.
"""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
BRIDGE = ROOT / "bridge"
for p in (str(ROOT), str(BRIDGE)):
    if p not in sys.path:
        sys.path.insert(0, p)


@pytest.fixture(autouse=True)
def isolate_bridge(tmp_path, monkeypatch):
    import server

    monkeypatch.setattr(server, "RECEIPTS", tmp_path / "receipts")
    monkeypatch.setattr(server, "STATE_PATH", tmp_path / ".state.json")
    # reset in-memory globals to a known disarmed baseline
    server._arm.update({"armed": False, "until": 0.0, "token": ""})
    server._queue.clear()
    server._results.clear()
    yield
