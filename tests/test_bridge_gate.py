"""Re-runnable proof for the browser-leash bridge gate.

browser-leash is the one component that takes real, irreversible actions on
real accounts (posting to X, navigating/clicking productive apps). The public
claim is "local-only, sticky ARM, human Post confirm, host allowlist." These
tests are the evidence:

  - while DISARMED, no write action queues — not even x.post;
  - only allowlisted hosts pass tab.navigate;
  - x.post text is validated and carries the post-confirm flag;
  - the arm state machine arms, disarms, and honors TTL expiry.

Everything runs offline against temp receipts/state (see conftest). ALLOW paths
that would otherwise block waiting on the extension use timeout=0 so they
return immediately after passing the gate — the point being *that they passed
the gate*, which is what we assert.
"""

from __future__ import annotations

import server


def _install_fast_clock(monkeypatch):
    """Advance the bridge clock far on every call so the post-enqueue wait loop
    exits immediately. (payload timeout=0 does NOT work: `timeout or default`
    treats 0 as missing and falls back to the 90-150s default.)"""
    clock = {"t": 1000.0}

    def fake_now():
        v = clock["t"]
        clock["t"] += 1_000_000.0
        return v

    monkeypatch.setattr(server, "_now", fake_now)


# ---- disarmed baseline: nothing acts --------------------------------------

def test_disarmed_by_default():
    assert server._arm_active() is False


def test_unknown_action_denied():
    out = server.enqueue_action({"action": "shell.exec", "cmd": "id"})
    assert out["ok"] is False and out["code"] == "UNKNOWN_ACTION"


def test_xpost_denied_when_disarmed():
    # the core guarantee: a post cannot even queue unless the operator armed it
    out = server.enqueue_action({"action": "x.post", "click_only": True})
    assert out["ok"] is False and out["code"] == "NOT_ARMED"
    assert server._queue == []  # nothing queued


def test_every_write_action_denied_when_disarmed():
    for action in ("x.post", "x.compose_draft", "page.click", "page.type", "tab.navigate"):
        out = server.enqueue_action({"action": action, "text": "hi", "url": "https://x.com/"})
        assert out["code"] == "NOT_ARMED", f"{action} should be denied while disarmed"


# ---- host allowlist -------------------------------------------------------

def test_host_allowed_pure():
    assert server._host_allowed("https://x.com/home") is True
    assert server._host_allowed("https://github.com/StellarRequiem") is True
    assert server._host_allowed("https://evil.example.com/x") is False
    assert server._host_allowed("not a url") is False
    assert server._host_allowed("") is False


def test_navigate_offlisted_host_denied_when_armed():
    server._set_arm(True, ttl=0)
    out = server.enqueue_action({"action": "tab.navigate", "url": "https://evil.example.com/"})
    assert out["ok"] is False and out["code"] == "HOST_DENIED"


def test_navigate_allowlisted_host_passes_gate(monkeypatch):
    _install_fast_clock(monkeypatch)
    server._set_arm(True, ttl=0)
    out = server.enqueue_action({"action": "tab.navigate", "url": "https://x.com/home"})
    assert out["code"] == "TIMEOUT"  # passed gate, then no extension to complete it
    assert any(j["action"] == "tab.navigate" for j in server._queue)


# ---- extension liveness precheck ------------------------------------------

def test_disconnected_extension_denied():
    # Sticky bridge-arm alone is not enough: if the extension isn't helloing the
    # bridge, an armed action fails fast with EXTENSION_DISCONNECTED before it can
    # queue — nothing acts against a dead extension. (conftest normally simulates a
    # live extension; here we force the disconnected state.)
    server._set_arm(True, ttl=0)
    server._extension.update({"last_hello": 0.0, "version": None})
    out = server.enqueue_action({"action": "x.post", "click_only": True})
    assert out["ok"] is False and out["code"] == "EXTENSION_DISCONNECTED"
    assert server._queue == []  # nothing queued against a disconnected extension


# ---- x.post validation + confirm flag -------------------------------------

def test_compose_draft_empty_text_denied():
    server._set_arm(True, ttl=0)
    out = server.enqueue_action({"action": "x.compose_draft", "text": "   "})
    assert out["ok"] is False and out["code"] == "EMPTY_TEXT"


def test_xpost_text_too_long_denied():
    server._set_arm(True, ttl=0)
    out = server.enqueue_action({"action": "x.post", "text": "a" * 25001})
    assert out["ok"] is False and out["code"] == "TEXT_TOO_LONG"


def test_xpost_carries_post_confirm_flag(monkeypatch):
    _install_fast_clock(monkeypatch)
    server._set_arm(True, ttl=0)
    out = server.enqueue_action({"action": "x.post", "click_only": True})
    assert out["code"] == "TIMEOUT"  # gate passed; would await human Post confirm in the extension
    job = next(j for j in server._queue if j["action"] == "x.post")
    assert job["require_post_confirm"] is True


def test_status_reports_confirm_required_and_disarmed():
    out = server.enqueue_action({"action": "status"})
    assert out["require_post_confirm"] is True
    assert out["armed"] is False


# ---- arm state machine ----------------------------------------------------

def test_arm_then_disarm():
    server._set_arm(True, ttl=0)
    assert server._arm_active() is True
    server._set_arm(False)
    assert server._arm_active() is False


def test_timed_arm_expires(monkeypatch):
    base = 1_000_000.0
    monkeypatch.setattr(server, "_now", lambda: base)
    server._set_arm(True, ttl=60)  # expires at base+60
    assert server._arm_active() is True
    monkeypatch.setattr(server, "_now", lambda: base + 61)  # past expiry
    assert server._arm_active() is False
