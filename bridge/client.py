#!/usr/bin/env python3
"""CLI client for browser-leash bridge."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request

DEFAULT = "http://127.0.0.1:8756"


def call(base: str, path: str, body: dict | None = None) -> dict:
    url = base.rstrip("/") + path
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="GET" if body is None else "POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as e:
        return {"ok": False, "code": "BRIDGE_DOWN", "detail": str(e)}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="browser-leash")
    p.add_argument("--base", default=DEFAULT)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status")
    n = sub.add_parser("navigate")
    n.add_argument("--url", required=True)
    sub.add_parser("tabs")
    sub.add_parser("page")

    d = sub.add_parser("draft")
    d.add_argument("--text", default="")
    d.add_argument("--text-file", default="")

    po = sub.add_parser("post")
    po.add_argument("--text", default="")
    po.add_argument("--text-file", default="")
    po.add_argument(
        "--click-only",
        action="store_true",
        help="click Post only (no re-fill; use after a good draft)",
    )

    sn = sub.add_parser("snapshot", help="active page text snapshot")
    sc = sub.add_parser("screenshot", help="capture visible tab PNG dataUrl")
    sc.add_argument("--out", default="", help="write PNG path if dataUrl returned")
    cl = sub.add_parser("click")
    cl.add_argument("--selector", required=True)
    ty = sub.add_parser("type")
    ty.add_argument("--selector", default="")
    ty.add_argument("--text", required=True)
    pr = sub.add_parser("press", help="key press on active element")
    pr.add_argument("--key", default="Enter")
    scrl = sub.add_parser("scroll", help="scroll page by dy (default 600)")
    scrl.add_argument("--dy", type=int, default=600)
    scrl.add_argument("--dx", type=int, default=0)

    ar = sub.add_parser(
        "article",
        help="read full X article / status / thread body (scroll + extract)",
    )
    ar.add_argument(
        "--url",
        default="",
        help="optional x.com URL (status, /i/article/, …); omit to use active tab",
    )
    ar.add_argument("--max-scrolls", type=int, default=30)
    ar.add_argument("--max-chars", type=int, default=200000)
    ar.add_argument(
        "--out",
        default="",
        help="optional path to write body text (UTF-8)",
    )

    args = p.parse_args(argv)
    base = args.base

    if args.cmd == "status":
        print(json.dumps(call(base, "/v1/status"), indent=2))
        return 0
    if args.cmd == "tabs":
        print(json.dumps(call(base, "/v1/action", {"action": "tab.list"}), indent=2))
        return 0
    if args.cmd == "page":
        print(json.dumps(call(base, "/v1/action", {"action": "page.info"}), indent=2))
        return 0
    if args.cmd == "navigate":
        print(
            json.dumps(
                call(base, "/v1/action", {"action": "tab.navigate", "url": args.url}),
                indent=2,
            )
        )
        return 0

    def load_text(a: argparse.Namespace) -> str:
        if a.text_file:
            return open(a.text_file, encoding="utf-8").read()
        return a.text

    if args.cmd == "draft":
        text = load_text(args)
        print(
            json.dumps(
                call(base, "/v1/action", {"action": "x.compose_draft", "text": text}),
                indent=2,
            )
        )
        return 0
    if args.cmd == "post":
        # click-only avoids re-fill after a successful draft (prevents double-text)
        if getattr(args, "click_only", False):
            payload = {"action": "x.post", "text": "", "confirm": True, "click_only": True}
        else:
            text = load_text(args)
            payload = {"action": "x.post", "text": text, "confirm": True}
        print(json.dumps(call(base, "/v1/action", payload), indent=2))
        return 0
    if args.cmd == "snapshot":
        print(json.dumps(call(base, "/v1/action", {"action": "page.snapshot"}), indent=2)[:8000])
        return 0
    if args.cmd == "article":
        body: dict = {
            "action": "x.article_read",
            "max_scrolls": args.max_scrolls,
            "max_chars": args.max_chars,
        }
        if args.url:
            body["url"] = args.url
        res = call(base, "/v1/action", body)
        if args.out and res.get("ok"):
            data = res.get("data") or {}
            text = data.get("body") or ""
            try:
                with open(args.out, "w", encoding="utf-8") as f:
                    f.write(text)
                res.setdefault("data", {})["out"] = args.out
            except OSError as e:
                res = {**res, "out_error": str(e)}
        # Print meta + body prefix (full body may be huge)
        print(json.dumps(res, indent=2, default=str)[:24000])
        return 0 if res.get("ok") else 1
    if args.cmd == "screenshot":
        res = call(base, "/v1/action", {"action": "page.screenshot"})
        if args.out and res.get("data", {}).get("dataUrl"):
            import base64
            import re

            m = re.match(r"data:image/png;base64,(.+)", res["data"]["dataUrl"], re.S)
            if m:
                open(args.out, "wb").write(base64.b64decode(m.group(1)))
                res = {**res, "saved": args.out, "data": {k: v for k, v in res.get("data", {}).items() if k != "dataUrl"}}
        print(json.dumps({k: v for k, v in res.items() if k != "data" or "dataUrl" not in str(v)}, indent=2)[:2000])
        return 0 if res.get("ok") else 1
    if args.cmd == "click":
        print(
            json.dumps(
                call(base, "/v1/action", {"action": "page.click", "selector": args.selector}),
                indent=2,
            )
        )
        return 0
    if args.cmd == "type":
        print(
            json.dumps(
                call(
                    base,
                    "/v1/action",
                    {"action": "page.type", "selector": args.selector, "text": args.text},
                ),
                indent=2,
            )
        )
        return 0
    if args.cmd == "press":
        print(
            json.dumps(
                call(base, "/v1/action", {"action": "page.press", "key": args.key}),
                indent=2,
            )
        )
        return 0
    if args.cmd == "scroll":
        print(
            json.dumps(
                call(
                    base,
                    "/v1/action",
                    {"action": "page.scroll", "dx": args.dx, "dy": args.dy},
                ),
                indent=2,
            )
        )
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
