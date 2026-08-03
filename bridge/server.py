#!/usr/bin/env python3
"""browser-leash bridge — loopback control plane (stdlib only).

Agent → POST /v1/action
Extension → GET /v1/poll  ·  POST /v1/result  ·  POST /v1/arm
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
RECEIPTS = ROOT / "receipts"
STATE_PATH = Path(__file__).resolve().parent / ".state.json"
HOST = "127.0.0.1"
PORT = int(os.environ.get("BROWSER_LEASH_PORT", "8756"))
# Optional timed arm: set BROWSER_LEASH_ARM_TTL>0 for expiry (seconds).
# Default 0 = sticky toggle until DISARM (operator request 2026-07-28).
ARM_TTL_SEC = int(os.environ.get("BROWSER_LEASH_ARM_TTL", "0"))
REQUIRE_POST_CONFIRM = os.environ.get("BROWSER_LEASH_POST_CONFIRM", "1") not in (
    "0",
    "false",
    "no",
)

ALLOWED_HOSTS = frozenset(
    {
        "x.com",
        "twitter.com",
        "www.x.com",
        "www.twitter.com",
        "github.com",
        "www.github.com",
        "docs.github.com",
        "xclusivexo.com",
        "www.xclusivexo.com",
        "pypi.org",
        "www.pypi.org",
        "localhost",
        "127.0.0.1",
        "privateemail.com",
        "linkedin.com",
        "www.linkedin.com",
        "reddit.com",
        "www.reddit.com",
        "old.reddit.com",
        "upwork.com",
        "www.upwork.com",
    }
)

# Tier notes: see docs/PERMISSION_TIERS.md
ALLOWED_ACTIONS = frozenset(
    {
        # T1 observe
        "tab.list",
        "page.info",
        "page.snapshot",
        "page.screenshot",
        "x.article_read",  # full article/status body (scroll + extract)
        "x.article_search",  # keyword search → result cards
        # T2 interact
        "tab.navigate",
        "page.click",
        "page.type",
        "page.press",
        "page.scroll",
        # T3 compose / T4 publish
        "x.compose_draft",
        "x.post",
    }
)

# Risk labels for status/agents (informational; enforcement is arm + allowlist)
ACTION_TIERS = {
    "tab.list": 1,
    "page.info": 1,
    "page.snapshot": 1,
    "page.screenshot": 1,
    "x.article_read": 1,
    "x.article_search": 1,
    "tab.navigate": 2,
    "page.click": 2,
    "page.type": 2,
    "page.press": 2,
    "page.scroll": 2,
    "x.compose_draft": 3,
    "x.post": 4,
}

_lock = threading.Lock()
_queue: list[dict[str, Any]] = []
_results: dict[str, dict[str, Any]] = {}
_arm: dict[str, Any] = {"armed": False, "until": 0.0, "token": ""}
_extension: dict[str, Any] = {
    "version": None,
    "hasDebugger": None,
    "last_hello": 0.0,
}


def _now() -> float:
    return time.time()


def _receipt(kind: str, body: dict[str, Any]) -> None:
    RECEIPTS.mkdir(parents=True, exist_ok=True)
    path = RECEIPTS / f"{time.strftime('%Y-%m-%d')}.jsonl"
    line = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "kind": kind,
        **body,
    }
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(line, sort_keys=True) + "\n")


def _arm_active() -> bool:
    with _lock:
        if not _arm.get("armed"):
            return False
        until = float(_arm.get("until") or 0)
        # until <= 0 means sticky toggle (no expiry)
        if until > 0 and _now() > until:
            _arm["armed"] = False
            _arm["until"] = 0.0
            return False
        return True


def _set_arm(armed: bool, ttl: int | None = None) -> dict[str, Any]:
    """Arm as sticky toggle (ttl=0) or timed (ttl>0 seconds)."""
    if ttl is None:
        ttl = ARM_TTL_SEC
    with _lock:
        if armed:
            token = hashlib.sha256(os.urandom(32)).hexdigest()[:16]
            until = 0.0 if int(ttl) <= 0 else _now() + int(ttl)
            _arm.update({"armed": True, "until": until, "token": token})
        else:
            _arm.update({"armed": False, "until": 0.0, "token": ""})
        snap = dict(_arm)
    _receipt(
        "arm",
        {
            "armed": snap["armed"],
            "until": snap["until"],
            "mode": "toggle" if not snap["until"] else "timed",
        },
    )
    _save_state()
    return snap


def _save_state() -> None:
    with _lock:
        data = {"arm": dict(_arm), "saved_at": _now()}
    try:
        STATE_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except OSError:
        pass


def _load_state() -> None:
    if not STATE_PATH.is_file():
        return
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        arm = data.get("arm") or {}
        with _lock:
            _arm.update(
                {
                    "armed": bool(arm.get("armed")),
                    "until": float(arm.get("until") or 0),
                    "token": str(arm.get("token") or ""),
                }
            )
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        pass


def _host_allowed(url: str) -> bool:
    try:
        u = urlparse(url)
    except Exception:
        return False
    host = (u.hostname or "").lower()
    return host in ALLOWED_HOSTS


def enqueue_action(payload: dict[str, Any]) -> dict[str, Any]:
    action = str(payload.get("action") or "").strip()
    if action == "status":
        with _lock:
            ext = dict(_extension)
        return {
            "ok": True,
            "bridge": "up",
            "armed": _arm_active(),
            "arm_until": _arm.get("until"),
            "require_post_confirm": REQUIRE_POST_CONFIRM,
            "allowed_actions": sorted(ALLOWED_ACTIONS),
            "allowed_hosts": sorted(ALLOWED_HOSTS),
            "queue_depth": len(_queue),
            "extension": ext,
            "expect_extension_version": "0.4.3",
            "arm_mode": "toggle" if ARM_TTL_SEC <= 0 else f"timed_{ARM_TTL_SEC}s",
            "action_tiers": dict(ACTION_TIERS),
            "permission_doc": "docs/PERMISSION_TIERS.md",
        }

    if action not in ALLOWED_ACTIONS:
        _receipt("deny", {"action": action, "reason": "UNKNOWN_ACTION"})
        return {"ok": False, "code": "UNKNOWN_ACTION", "detail": f"unknown action {action!r}"}

    if not _arm_active():
        _receipt("deny", {"action": action, "reason": "NOT_ARMED"})
        return {
            "ok": False,
            "code": "NOT_ARMED",
            "detail": "extension must be ARMED (popup) before browser actions",
        }

    # Fail fast if extension is not polling (sticky arm on bridge alone is not enough)
    with _lock:
        last_hello = float((_extension or {}).get("last_hello") or 0)
        ext_ver = (_extension or {}).get("version")
    if last_hello <= 0 or (_now() - last_hello) > 45:
        _receipt(
            "deny",
            {
                "action": action,
                "reason": "EXTENSION_DISCONNECTED",
                "last_hello": last_hello,
                "version": ext_ver,
            },
        )
        return {
            "ok": False,
            "code": "EXTENSION_DISCONNECTED",
            "detail": (
                "extension not helloing the bridge — Soft Reload Browser Leash, "
                "then ARM (popup). Sticky bridge arm alone is not enough."
            ),
            "extension": {"version": ext_ver, "last_hello": last_hello},
        }

    if action in ("tab.navigate", "x.article_read", "x.article_search"):
        url = str(payload.get("url") or "")
        if url and not _host_allowed(url):
            _receipt("deny", {"action": action, "url": url, "reason": "HOST_DENIED"})
            return {"ok": False, "code": "HOST_DENIED", "detail": f"host not allowlisted: {url}"}
        if action == "x.article_search":
            q = str(payload.get("query") or payload.get("q") or "").strip()
            if not q and not url:
                return {
                    "ok": False,
                    "code": "QUERY_REQUIRED",
                    "detail": "query or url required for x.article_search",
                }
            if len(q) > 500:
                return {"ok": False, "code": "QUERY_TOO_LONG", "detail": "query max 500 chars"}

    if action in ("x.post", "x.compose_draft"):
        text = str(payload.get("text") or "")
        click_only = bool(payload.get("click_only") or payload.get("clickOnly"))
        if action == "x.compose_draft" and not text.strip():
            return {"ok": False, "code": "EMPTY_TEXT", "detail": "text required"}
        if action == "x.post" and not click_only and not text.strip():
            return {"ok": False, "code": "EMPTY_TEXT", "detail": "text required (or pass click_only)"}
        if len(text) > 25000:
            return {"ok": False, "code": "TEXT_TOO_LONG", "detail": "text exceeds 25k chars"}

    if action == "x.article_read":
        # Cap scroll/char knobs so a single job cannot hang the queue forever
        try:
            ms = int(payload.get("max_scrolls") or payload.get("maxScrolls") or 30)
            payload["max_scrolls"] = max(1, min(ms, 80))
        except (TypeError, ValueError):
            payload["max_scrolls"] = 30
        try:
            mc = int(payload.get("max_chars") or payload.get("maxChars") or 200000)
            payload["max_chars"] = max(1000, min(mc, 500000))
        except (TypeError, ValueError):
            payload["max_chars"] = 200000

    job_id = str(uuid.uuid4())
    job = {
        "id": job_id,
        "action": action,
        "created_at": _now(),
        "payload": payload,
        "require_post_confirm": REQUIRE_POST_CONFIRM and action == "x.post",
    }
    with _lock:
        _queue.append(job)
    _receipt("enqueue", {"id": job_id, "action": action})

    # wait for extension result (timeout)
    # article_read scrolls — needs a longer default window
    if action == "x.post":
        default_timeout = 150
    elif action in ("x.article_read", "x.article_search"):
        default_timeout = 120
    else:
        default_timeout = 90
    timeout = float(payload.get("timeout") or default_timeout)
    deadline = _now() + timeout
    while _now() < deadline:
        with _lock:
            if job_id in _results:
                res = _results.pop(job_id)
                # strip huge screenshot payloads from disk receipts
                receipt_res = dict(res)
                data = receipt_res.get("data")
                if isinstance(data, dict) and "dataUrl" in data:
                    receipt_res["data"] = {
                        k: v for k, v in data.items() if k != "dataUrl"
                    }
                    receipt_res["data"]["dataUrl_omitted"] = True
                _receipt("result", {"id": job_id, "action": action, "result": receipt_res})
                return {"ok": bool(res.get("ok")), "id": job_id, "action": action, **res}
        time.sleep(0.15)
    _receipt("timeout", {"id": job_id, "action": action})
    return {"ok": False, "code": "TIMEOUT", "id": job_id, "detail": "extension did not complete in time"}


class Handler(BaseHTTPRequestHandler):
    server_version = "browser-leash/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        # quiet — still receipt-log important events
        pass

    def _json(self, code: int, obj: dict[str, Any]) -> None:
        raw = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")  # extension pages
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._json(204, {})

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/v1/status":
            self._json(200, enqueue_action({"action": "status"}))
            return
        if path == "/v1/poll":
            # extension long-ish poll for next job
            qs = parse_qs(urlparse(self.path).query)
            wait = min(float((qs.get("wait") or ["5"])[0]), 25.0)
            deadline = _now() + wait
            job = None
            while _now() < deadline:
                with _lock:
                    if _queue:
                        job = _queue.pop(0)
                        break
                time.sleep(0.2)
            if job is None:
                self._json(200, {"job": None, "armed": _arm_active()})
            else:
                self._json(200, {"job": job, "armed": _arm_active()})
            return
        self._json(404, {"ok": False, "code": "NOT_FOUND"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._json(400, {"ok": False, "code": "BAD_JSON"})
            return
        if not isinstance(body, dict):
            self._json(400, {"ok": False, "code": "BAD_BODY"})
            return

        if path == "/v1/action":
            self._json(200, enqueue_action(body))
            return
        if path == "/v1/arm":
            armed = bool(body.get("armed"))
            # Preserve ttl=0 (sticky). `or ARM_TTL` would treat 0 as missing.
            ttl = body.get("ttl")
            ttl = ARM_TTL_SEC if ttl is None else int(ttl)
            snap = _set_arm(armed, ttl=ttl)
            self._json(
                200,
                {
                    "ok": True,
                    "armed": snap["armed"] and _arm_active(),
                    "until": snap["until"],
                    "token": snap["token"] if snap["armed"] else "",
                },
            )
            return
        if path == "/v1/result":
            jid = str(body.get("id") or "")
            if not jid:
                self._json(400, {"ok": False, "code": "MISSING_ID"})
                return
            with _lock:
                _results[jid] = {
                    "ok": bool(body.get("ok")),
                    "detail": body.get("detail"),
                    "data": body.get("data"),
                    "code": body.get("code"),
                }
            self._json(200, {"ok": True})
            return
        if path == "/v1/hello":
            with _lock:
                _extension["version"] = body.get("extensionVersion")
                _extension["hasDebugger"] = body.get("hasDebugger")
                _extension["last_hello"] = _now()
            self._json(200, {"ok": True, "expect": "0.3.9"})
            return
        self._json(404, {"ok": False, "code": "NOT_FOUND"})


def main() -> None:
    _load_state()
    RECEIPTS.mkdir(parents=True, exist_ok=True)
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"browser-leash bridge on http://{HOST}:{PORT}", flush=True)
    print(f"arm_ttl={ARM_TTL_SEC}s post_confirm={REQUIRE_POST_CONFIRM}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye", flush=True)


if __name__ == "__main__":
    main()
