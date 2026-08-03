# Permission tiers — expanding access the right way

**Principle:** more capability ≠ ambient authority. Every expansion stays:

1. **Loopback only** (bridge on `127.0.0.1`)
2. **Deny-by-default** (unknown action/host refused)
3. **Arm-gated** (sticky **toggle** by default — stays on until **DISARM**; optional timed via `BROWSER_LEASH_ARM_TTL`)
4. **Receipted** (append-only `receipts/`)
5. **Human-final for high-blast** (X publish default confirm-on)

## Tiers

| Tier | Name | Requires | Actions (examples) |
|------|------|----------|-------------------|
| **T0** | Bridge status | none | `GET /v1/status` (no page mutation) |
| **T1** | Observe | ARM | `tab.list`, `page.info`, `page.snapshot`, `page.screenshot`, **`x.article_read`** (full article/status body) |
| **T2** | Interact | ARM | `tab.navigate` (allowlist), `page.click`, `page.type`, `page.press`, `page.scroll` |
| **T3** | Compose | ARM | `x.compose_draft` (fill only; no Post click) |
| **T4** | Publish | ARM + **post confirm** (default) | `x.post` / `post --click-only` |

T4 is intentionally expensive. Operator adversarial hold-test (2026-07-28): unarmed path and disabled-Post path **held closed**.

## Host allowlist policy

**In (professional surface):**

- `x.com` / `twitter.com` — social (gated publish)
- `github.com` — code
- `xclusivexo.com` — own site
- `pypi.org` / `www.pypi.org` — package proof
- `docs.github.com` — docs
- `localhost` / `127.0.0.1` — local tools

**Out unless operator expands list in `bridge/server.py` + reload:**

- Arbitrary web (no free browsing)
- Banking, mail, cloud consoles, password managers

To add a host: edit `ALLOWED_HOSTS`, restart bridge, append here with date + why.

## Action expansion checklist

Before adding any action:

- [ ] Listed in `ALLOWED_ACTIONS`
- [ ] Handled in extension `runJob`
- [ ] CLI surface (if agent-facing)
- [ ] Receipt on deny and result
- [ ] Documented tier (T1–T4)
- [ ] No silent credential access

## Agent SOP (Grok)

1. Prefer **T1** before T2 (snapshot before click)
2. Prefer **T3 draft** then human or click-only for T4
3. Never claim T4 success without `POST_CLICKED` or operator post + live proof
4. After code change: Reload until `extension.version` matches `expect_extension_version`

## Relation to mcp-assure

Browser actions are a **tool surface**. Future: optional policy pack `browser_leash` that rate-limits navigate/post via AdaptiveGate. Until then, arm + allowlist + confirm are the gate.

## Operator grant path (more control)

When operator says “more access”:

1. Name the **host** or **action** needed (one sentence why)
2. Agent proposes tier + blast
3. Operator approves → code change + docs append
4. Prove with small re-runnable command
5. DISARM when session ends

Do **not** grant “all sites” or “no arm” without explicit operator override phrase.

---

## Related plan: full computer use

Desktop / multi-app control is **not** this package. See:

**`~/ops/DESKTOP_LEASH_PLAN.md`** — planned `desktop-leash` (macOS AX + screen + gated input).

| Need | Plane |
|------|--------|
| Chrome / X / GitHub web | **browser-leash** (this project) |
| Other apps / desktop UI | **desktop-leash** (planned) |
| Tool-call policy | **mcp-assure** |
