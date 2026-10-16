# Agent control plane — browser-leash

## When operator says “post to X”

1. Ensure bridge is up: `curl -s http://127.0.0.1:8756/v1/status`
2. If `armed: false`, tell operator to open **Browser Leash** popup → **ARM (on)** (sticky toggle until DISARM)
3. After extension code changes: operator must **Reload** the extension, then re-ARM if needed
4. Prefer ≤280 characters unless Premium long-form is confirmed
5. Write post text to a temp file (preserve newlines)
6. Navigate compose first (more reliable):

```bash
python3 ~/browser-leash/bridge/client.py navigate --url "https://x.com/compose/post"
python3 ~/browser-leash/bridge/client.py draft --text-file /tmp/x-post.txt
# check result data.gotLen / postDisabled / firstLine
# Prefer: if postDisabled, ask operator to click Post (do NOT immediately re-post fill)
# Only if postDisabled=false:
python3 ~/browser-leash/bridge/client.py post --text-file /tmp/x-post.txt
# or click-only after a good draft (avoids double-fill):
python3 ~/browser-leash/bridge/client.py post --click-only
```

7. If confirm mode on: badge **POST** → popup → **Confirm post**
8. Report bridge JSON + code. Success only if `ok: true` and `POST_CLICKED` **or** operator posted + live snapshot
9. If `POST_DISABLED` / `FILL_FAILED`: React fill failed — do not claim post; do not stack another fill without clear
10. Remind operator to **DISARM** when done
11. After any extension code change: operator **Reload** until `status.extension.version` matches disk (0.3.2+)

## Browser actions (ambient Chrome under leash — 0.5.1+)

**Screenshot:** `page.screenshot` activates the target tab, captures via `windowId`, requires host_permissions `<all_urls>` (extension 0.5.1+). Prefer agent-control `browser.screenshot` with `out` path under `~/ops` or `/tmp`.

Prefer **agent-control** host tools:

```bash
python3 ~/agent-control/cli.py call browser.tabs
python3 ~/agent-control/cli.py call browser.tab_create --args-json '{"url":"https://xclusivexo.com/"}'
python3 ~/agent-control/cli.py call browser.navigate --args-json '{"url":"https://github.com/StellarRequiem/mcp-assure"}'
python3 ~/agent-control/cli.py call browser.wait --args-json '{"mode":"load"}'
python3 ~/agent-control/cli.py call browser.find --args-json '{"selector":"a","limit":10}'
python3 ~/agent-control/cli.py call browser.links --args-json '{"limit":20}'
python3 ~/agent-control/cli.py call browser.snapshot
python3 ~/agent-control/cli.py call browser.tab_close --args-json '{}'
```

Direct leash:

```bash
python3 ~/browser-leash/bridge/client.py tabs
python3 ~/browser-leash/bridge/client.py navigate --url "https://github.com/StellarRequiem/mcp-assure"
python3 ~/browser-leash/bridge/client.py snapshot
python3 ~/browser-leash/bridge/client.py screenshot --out /tmp/page.png
python3 ~/browser-leash/bridge/client.py click --selector "css-selector"
python3 ~/browser-leash/bridge/client.py type --selector "input" --text "hello"
```

## Read full X articles / posts (0.4.0+)

Prefer the **assured host** path:

```bash
python3 ~/agent-control/cli.py call browser.x_article_read \
  --args-json '{"url":"https://x.com/i/article/…"}'
# or status / thread:
python3 ~/agent-control/cli.py call browser.x_article_read \
  --args-json '{"url":"https://x.com/user/status/123"}'
```

Direct leash:

```bash
python3 ~/browser-leash/bridge/client.py article --url "https://x.com/…/status/…" --out /tmp/x-article.txt
```

Returns structured `body`, `char_count`, `word_count`, `kind` (`article`|`status`|…), author/handle when present.  
Requires **ARM** + extension **0.4.3+** (Soft Reload until `extension.version` matches `expect_extension_version`).  
T1 observe only — does not publish.

## Search + curate X articles / posts (0.4.3+)

```bash
# Search only (cards)
python3 ~/agent-control/cli.py call browser.x_article_search \
  --args-json '{"query":"mcp agent security","sort":"latest","max_results":15}'

# Search + rank + optional full-read of top N
python3 ~/agent-control/cli.py call browser.x_article_curate \
  --args-json '{"query":"mcp agent security","top_n":5,"read_top":2,"sort":"latest"}'

# Direct leash search
python3 ~/browser-leash/bridge/client.py search -q "mcp assure" --sort latest --max-results 12
```

Curation is **heuristic** (keyword hits + article kind + light engagement) under the leash — not X API, not editorial AI.

## Rules

- **Never** claim a successful post without `ok: true` from the bridge
- **Never** store X passwords; session is the operator’s Chrome login
- Deny-by-default: unknown hosts/actions fail closed
- Prefer draft first if operator wants review without posting

## Start bridge (if down)

```bash
python3 ~/browser-leash/bridge/server.py
# or:
# nohup python3 ~/browser-leash/bridge/server.py >>~/browser-leash/receipts/bridge.log 2>&1 &
```

## Parity note

Claude/Codex use proprietary Chrome native hosts + optional Computer Use.  
browser-leash is our **local deny-by-default** Chrome session control plane — not full desktop CUA.
See `docs/CAPABILITY_GAP.md`.
