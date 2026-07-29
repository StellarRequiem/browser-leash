# Load Browser Leash in Chrome

1. Start bridge:
   ```bash
   python3 ~/browser-leash/bridge/server.py
   ```
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. **Load unpacked** → choose:
   ```
   /Users/llm01/browser-leash/extension
   ```
5. Pin **Browser Leash**
6. Click the icon → **ARM (on)** — sticky toggle until **DISARM** (no 15m timer by default)
7. Stay logged into x.com in that Chrome profile
8. When Grok posts: if badge shows **POST**, open popup → **Confirm post**
9. **DISARM (off)** when finished — required (no auto-timeout)

Optional timed arm: `BROWSER_LEASH_ARM_TTL=900` on the bridge process.

## Verify

```bash
python3 ~/browser-leash/bridge/client.py status
# armed should become true after popup ARM (bridge arm endpoint)
# extension.version should match disk (expect 0.3.2+). If still 0.3.1 → Reload again.
```

## Append — reload + sticky ARM (0.3.6)

Disk **0.3.6**. Soft Reload often sticks on old SW — hard reload if version badge wrong.

### Soft reload
1. `chrome://extensions` → Browser Leash → **Reload**
2. Popup: **Version: 0.3.6** + **Arm: ON** after **ARM (on)**
3. Badge should show **ARM** while armed

### Hard reload
1. **Remove** → **Load unpacked** → `~/browser-leash/extension`
2. **ARM (on)** once — stays on until **DISARM**

Sequence state: `docs/CAPABILITY_GAP.md` · `~/ops/STATE-2026-07-28.md`
