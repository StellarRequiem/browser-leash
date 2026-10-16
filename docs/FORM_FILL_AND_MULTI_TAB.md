# Form-fill, multi-tab & multi-page helpers

**Constraint:** improve capability **without** ambient authority. ARM + host allowlist + receipts still required.  
**Host path:** prefer `agent-control` (`browser.*` / `browser.workspace`) so AdaptiveGate sees every step.  
**Deep SOP:** `~/agent-control/docs/MULTI_SURFACE_NAVIGATION.md` (tabs · pages · screens).

## Current

| Action | Status |
|--------|--------|
| `page.click` / `page.type` / `page.scroll` | Available under ARM; **tabId supported** |
| `page.find` / `page.links` / `page.snapshot` | Observe first; **tabId supported** |
| Multi-tab | `tab.list`, `tab.create`, `tab.activate`, `tab.close`, navigate with `tabId` |
| Multi-page | `page.back` / `forward` / `reload` / `wait` with optional `tabId` |
| Complex forms (iframes, React controlled inputs) | Partial — may need multiple type+click |
| Multi-screen (OS windows) | **desktop-leash** layout + `click_window` — not this bridge |

## Multi-tab patterns (safe)

1. **Orient:** `browser.workspace` (via agent-control) or `tab.list` — pin `tabId` before acting.  
2. **Parallel research:** `tab.create` with `active: false` so the current page stays focused.  
3. Pass **`tabId`** on navigate / snapshot / click / type / scroll / find / links / wait.  
4. **Screenshot** is active-window only — host activates `tabId` first when provided.  
5. Fail closed on non-allowlisted host.

## Multi-page patterns (safe)

1. **Snapshot → find → click → type** (never guess coords).  
2. Prefer `input[name=…]` / `data-testid` over brittle text.  
3. After type, re-snapshot to verify fill.  
4. Long pages: `scroll dy=600–900` then snapshot; reuse tools (avoid TOOL_SPRAY).  
5. Prefer `navigate` to a known href over fragile mid-SPA state when possible.  
6. `back` / `forward` stay on the same `tabId`.

## Form-fill patterns (safe)

1. Snapshot → find fields → type one field → snapshot verify.  
2. Avoid stacking draft + full post fill on X (double text).  
3. iframes: only on allowlisted origins; pierce is limited — if find misses, report gap.  

## Not in scope (by design)

- Cloud browser  
- Unattended form spam  
- Bypass FREEZE  
- Full multi-display OS automation (desktop-leash + budgets only)

## agent-control tools

```bash
python3 ~/agent-control/cli.py call browser.workspace --args-json '{"snapshot":false}'
python3 ~/agent-control/cli.py call browser.tab_create --args-json '{"url":"https://xclusivexo.com/","active":false}'
python3 ~/agent-control/cli.py call browser.snapshot --args-json '{"tabId":123}'
python3 ~/agent-control/cli.py call browser.navigate --args-json '{"url":"https://…","tabId":123}'
```

## Future (P1+)

- Skill: multi-step “fill allowlisted form” with step receipts  
- iframe pierce only on allowlisted origins  
- Named tab roles (research / compose / docs) in workspace output  
