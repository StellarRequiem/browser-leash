# Claim gate — browser-leash

Public language must stay **≤ evidence**. Updated 2026-08-03.

## Allowed

| Claim | Evidence |
|-------|----------|
| Local Chrome control plane (loopback bridge + extension) | this repo · port **8756** |
| Sticky ARM toggle; host allowlist; deny-by-default actions | bridge + extension |
| Human confirm on publish (`require_post_confirm`) | status + `x.post` path |
| React-aware draft fill (multi-strategy CDP) | extension **0.3.8+** |
| Ambient multi-tab surface (tabs, wait, find, links, history) | extension **0.5.0+** · `docs/AGENT.md` |
| X article read + keyword search actions | `x.article_read` · `x.article_search` |
| Fail-fast when extension not helloing | `EXTENSION_DISCONNECTED` |

## Not allowed

| Overclaim | Why |
|-----------|-----|
| Auto-posts to X without human | Post confirm required |
| Full computer use / OS control | Chrome session only |
| Full SOC | Wrong product class |
| Free browsing of arbitrary hosts | Allowlist only |
| Native messaging parity with Claude/Codex | HTTP poll bridge |

## Versions (disk)

| Field | Value |
|-------|--------|
| Extension | **0.5.0** (`manifest.json` / `EXT_VERSION`) |
| Bridge expect | **0.5.0** |

## Recommended wording

> **browser-leash** is a local Chrome session control plane: sticky arm, host allowlist, receipts, ambient tab/read tools under arm, and human confirm on publish — not ambient RPA and not auto-post.
