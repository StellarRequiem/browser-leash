# browser-leash

**Local-only browser control plane** for agent-assisted navigation and gated X posts.

The agent talks to a **loopback bridge**. A **Chrome extension** executes allowlisted actions only while **armed** by the operator. Deny-by-default. No cloud. No auto-post without arm.

```
  Grok / CLI  ──HTTP 127.0.0.1──►  bridge  ◄──poll──  Chrome extension
                                      │
                                      ▼
                                 receipts/*.jsonl
```

## Safety model

| Control | Behavior |
|---------|----------|
| Loopback only | Bridge binds `127.0.0.1` |
| Deny-by-default | Unknown actions refused |
| Host policy | **Open-web default** (`BROWSER_LEASH_OPEN_WEB=1`): any https except password-manager denylist; ARM + action gate + FREEZE remain |
| **Arm / disarm** | Sticky **toggle** (popup ARM on / DISARM off). No 15m timer by default. Posts still need confirm. |
| Post confirmation | Optional bridge flag `require_post_confirm` (default **true**): extension shows confirm before Post click |
| Receipts | Every decision/result append-only under `receipts/` |
| No credentials | Uses your existing logged-in Chrome session — never stores passwords |

**Not** a full RPA platform. X DOM changes can break selectors; receipts record failures honestly.

## Install

### 1. Bridge

```bash
cd ~/browser-leash
python3 bridge/server.py
# listens http://127.0.0.1:8756
```

### 2. Chrome extension

1. Chrome → `chrome://extensions` → Developer mode ON  
2. **Load unpacked** → select `~/browser-leash/extension`  
3. Pin **Browser Leash**  
4. Open popup → **ARM** (sets a time-limited session)

### 3. Agent usage

```bash
# status
curl -s http://127.0.0.1:8756/v1/status | python3 -m json.tool

# draft only (no post click) — still needs arm
curl -s -X POST http://127.0.0.1:8756/v1/action \
  -H 'Content-Type: application/json' \
  -d '{"action":"x.compose_draft","text":"hello from browser-leash"}'

# post (arm required; extension may confirm)
curl -s -X POST http://127.0.0.1:8756/v1/action \
  -H 'Content-Type: application/json' \
  -d '{"action":"x.post","text":"...","confirm":true}'
```

CLI helper:

```bash
python3 bridge/client.py status
python3 bridge/client.py post --text-file /tmp/post.txt
```

## Actions

| Action | Requires arm | Notes |
|--------|--------------|-------|
| `status` | no | Bridge + last arm state |
| `tab.list` | yes | Open tabs (url/title) |
| `tab.navigate` | yes | Allowlisted host only |
| `page.info` | yes | Active tab url/title |
| `x.compose_draft` | yes | Fill compose; do not click Post |
| `x.post` | yes | Fill + Post; confirm if configured |
| `page.click` / `page.type` / `page.press` | yes | Generic page interaction |
| `page.scroll` | yes | Scroll by dx/dy |
| `page.snapshot` | yes | Visible text extract |
| `page.screenshot` | yes | Visible tab PNG (dataUrl to agent) |
| `post --click-only` | yes | Click Post without re-fill |

**Permission tiers (T0–T4):** see `docs/PERMISSION_TIERS.md` — expand access only with arm + allowlist + receipts.

See `docs/CAPABILITY_GAP.md` for Claude/Codex parity notes and the X Post-button failure analysis.

## Operator SOP (X posts)

1. Log into X in Chrome  
2. Start bridge  
3. ARM extension  
4. Ask Grok to post (or run `client.py post`)  
5. If confirm dialog appears, click **Confirm post**  
6. DISARM when done  

## Relation to mcp-assure / ADM

Same philosophy: **authority is not ambient**. Browser power is a tool surface; this leash is the gate. Optional future: route bridge actions through `mcp-assure` policies.

## Privacy

Local-only. Do not load this extension on a shared browser profile you do not control. Receipts may contain post text — `receipts/` is gitignored.

## License

Operator-private tooling unless you publish it. Default: keep private.
