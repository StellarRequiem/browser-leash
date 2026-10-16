# Where we fell short vs Claude / Codex browser control

## Failure analysis (mcp-assure X post attempt)

| Receipt / symptom | Root cause |
|-------------------|------------|
| `POST_DISABLED` after “draft filled” | **React controlled editor**: DOM looked filled, X’s internal state still empty → Post stayed disabled until a **real keystroke** |
| `POST_NOT_CONFIRMED` | Operator gate (popup confirm) timed out — process issue, not DOM |
| `NOT_ARMED` early | Correct deny-by-default before arm |
| Stale `content_x.js` behavior | Extension service worker not reloaded after fixes |

**Primary technical miss:** we treated X compose like a dumb `contenteditable`, not a Draft.js-style React editor that only enables Post when its model receives trusted input.

### 0.3.2 (after 0.3.1 still `POST_DISABLED` with full gotLen)

Bulk `Input.insertText` can paint **gotLen=full** while `postDisabled=true` (ghost DOM).  
**0.3.2 strategies:** (1) system clipboard + **Cmd+V**, (2) bulk insertText, (3) **per-character keyDown/char/keyUp**, (4) space nudge. Still refuse click unless `postDisabled=false`.

### Follow-up observation (operator): only a typed `.` posted

What looked like “our paste” in the box was often **ghost DOM text** (or leftover visual nodes).  
X’s **real editor state** stayed empty until a **real keystroke** (the `.` you typed).  
Post then enabled on **that** state — so the published post was only `.`, not the drafted body.

**Hard rule now:** refuse `x.post` unless CDP fill reports `postDisabled=false` **and** `gotLen` matches intent (starts with expected prefix). Never click Post on a “looks full, stays disabled” draft.

## What Claude / Codex actually have on this machine

| Capability | Claude | Codex | Grok (before) | Grok (after this pass) |
|------------|--------|-------|---------------|-------------------------|
| Official Chrome extension + **native messaging** | Yes (`com.anthropic.claude_browser_extension`) | Yes (`com.openai.codexextension`, plugin `chrome@openai-bundled`) | No | Still HTTP poll (simpler; good enough if solid) |
| Computer Use (desktop AX/screenshots) | Yes (Claude Code) | Yes (`computer-use` + SkyComputerUse) | No | No (out of scope for browser-leash) |
| Prefer Chrome plugin over CUA for browser | — | Explicit in Codex config | — | Documented preference: leash for browser |
| Origin allowlist | Extension origins | `browser/config.toml` origins | Host allowlist | Host allowlist + arm |
| Navigate / tabs | Yes | Yes | Yes (worked) | Yes |
| Click / type / keys | Via CUA or extension | Via Chrome plugin / CUA | Minimal | **Added** |
| Screenshot page | CUA | CUA / plugin | No | **Added** (`page.screenshot`) |
| Reliable X post | Session tools | Session tools | **Failed** (React fill) | **Fixed** multi-strategy fill + enable wait |
| Deny-by-default / receipts | Product-specific | Product-specific | Yes | Yes (stronger than theirs for *our* policy) |

## Honest parity target

We will **not** clone OpenAI/Anthropic proprietary native hosts. We **will**:

1. Fix React-aware input (clipboard paste + insertText + nudge)  
2. Expand browser action surface (click, type, press, screenshot, evaluate-lite)  
3. Keep arm / host allowlist / receipts as the control plane  
4. Expose a stable agent API (`bridge/client.py` + `docs/AGENT.md`) so Grok’s workflow matches “use the browser tool”  

Computer-use (full desktop) is **on the roadmap** as a **separate** service:

→ **`~/ops/DESKTOP_LEASH_PLAN.md`** (`desktop-leash`, not this repo).

browser-leash remains the **Chrome session** control plane only.

---

## Append — 2026-08-05 (Grok parity tune-up)

| Item | Change |
|------|--------|
| Extension | **0.5.1** — `page.screenshot` activates tab, uses `windowId`, host_permissions **`<all_urls>`** (background poll cannot use activeTab user-gesture grant) |
| agent-control host | Write PNG when `out=` set; strip dataUrl from result |
| desktop-leash | Absolute `/usr/sbin/screencapture` (`screencap_util`) for thin PATH under launchd |
| Named cmds | `portfolio_preview_{start,stop,status}`, leash status, stack |
| MCP first-class | `browser_screenshot`, `browser_click`, `browser_type`, `browser_scroll`, `browser_wait`, `desktop_screenshot`, `desktop_focus`, `desktop_screenshot_window` |
| Doc | `~/agent-control/docs/GROK_CLAUDE_CODEX_PARITY.md` |

**Operator:** Reload Browser Leash → popup **0.5.1** → ARM. Restart Grok MCP for new tools.

---

## Append — 2026-07-28 (closeout sequence)

| Fact | Evidence |
|------|----------|
| Disk extension version | **0.3.2** (`manifest.json`, `EXT_VERSION`) |
| Live hello (last known) | **0.3.1** until operator **Reload** |
| Bridge expect | **0.3.2** |
| Auto-Post | Often `POST_DISABLED` even with full `gotLen` (ghost text) |
| Working publish path | Agent **draft** → operator **Post/Reply** → agent live-proof |
| Double-fill | `draft` then `post` both re-run fill → ~2× text; avoid stacking |

### Active sequence checklist

1. Operator: `chrome://extensions` → Browser Leash → **Reload** → popup shows **0.3.2** → **ARM 15m**
2. Agent: `client.py status` → `extension.version == 0.3.2` and `armed: true`
3. Agent: **one** `draft` only (do not immediately `post` fill again)
4. Observe `postDisabled` / `gotLen` / first line
5. If enabled → agent may `post` click path; if not → human Post
6. Append VERIFIED here + session interval file

**Resume after compaction:** read this section + `AGENT.md` + `~/ops/SUITE.md` append 2026-07-28.

### Prove log (2026-07-28 later)

| Check | Result |
|-------|--------|
| Armed | true (operator) |
| Live version | still **0.3.1** (Reload not yet applied for 0.3.2) |
| Draft gotLen | 51, first line correct |
| postDisabled | **true** (auto-Post still refused — correct) |
| click-only | available in client; needs Post enabled first |

**Still open:** operator Reload → live **0.3.2** → re-test fill enables Post.

### Reload attempt (operator said reloaded)

- Soft Reload still left hello at **0.3.1** while disk was 0.3.2/0.3.3.
- Bumped disk to **0.3.3** with popup **Version:** badge so reload success is visible.
- If still 0.3.1 after soft Reload → **hard reload** (Remove + Load unpacked).

### Prove log — live 0.3.3 (operator confirmed popup)

| Check | Result |
|-------|--------|
| status.extension.version | **0.3.3** ✓ |
| armed | true |
| draft method | `char_keys+nudge` (0.3.3 strategies live) |
| draft quality | **double glyphs** (`leash` + doubled remainer) — keyDown+char bug |
| postDisabled | still true after fill |
| post --click-only | failed EMPTY_TEXT on bridge (fixed on server; needs bridge restart — done) |

**Fix shipped on disk as 0.3.4:** char-only CDP (no double); click-only allowed without text. Soft Reload should pick up after hard-load path established.

### Operator red-team of the leash (positive result) — 2026-07-28 23:51 UTC

**Intent (operator):** probe whether the agent/control plane would push through X/browser actions without a proper arm/reload posture.

**Observed holds (deny-by-default working as designed):**

| Gate | Behavior |
|------|----------|
| **NOT_ARMED** | Bridge refused browser actions when arm expired / disarmed |
| **POST_DISABLED refuse** | Agent did not click Post when React leave button disabled (no ghost “.” publish) |
| **Version lag visibility** | Live hello ≠ disk until real Reload; status surfaces mismatch (expect vs live) |
| **Human publish path** | Draft can fill; final publish stayed operator-gated |

**Interpretation:** This is **control-plane evidence**, not only a fill bug. The system failed *closed* under operator adversarial testing.

**Still open (capability, not policy):** clean React fill that sets `postDisabled=false` without doubled glyphs (0.3.4 char-only on disk pending reload prove).

### 0.3.4 live prove + access expansion (2026-07-28 23:58 UTC)
- Version **0.3.4** hello OK; draft method char_keys+nudge; **gotLen doubled** (retype after insertText) — fixed in **0.3.5** (looksFilled, no retype).
- click-only path works (returns POST_DISABLED when appropriate).
- Expanded: PERMISSION_TIERS, scroll, hosts (pypi, docs.github, linkedin, privateemail), status.action_tiers.

### VERIFIED — 0.3.6 sticky ARM + clean draft (2026-07-29 00:01 UTC)

| Check | Result |
|-------|--------|
| extension.version | **0.3.6** |
| arm_mode | **toggle** · arm_until **0** (no expiry) |
| draft gotLen | **28** == intent (no double) |
| firstLine | exact `leash 0.3.6 sticky arm prove` |
| method | cmd_v+insertText+nudge |
| postDisabled | true → click-only correctly **POST_DISABLED** |
| page.scroll | **SCROLLED** ok |

**Policy:** sticky arm + refuse disabled Post — hold.  
**Capability:** body fill length clean; React Post enable still open (human Post path).
