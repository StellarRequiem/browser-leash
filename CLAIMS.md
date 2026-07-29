# Claim gate — browser-leash

Public language must stay **≤ evidence**.

## Allowed

| Claim | Evidence |
|-------|----------|
| Local Chrome control plane (loopback bridge + extension) | this repo |
| Sticky ARM toggle; host allowlist; deny-by-default actions | bridge + extension |
| Human confirm on publish (`require_post_confirm`) | status + x.post path |
| React-aware draft fill (multi-strategy CDP) | extension 0.3.8+ |

## Not allowed

| Overclaim | Why |
|-----------|-----|
| Auto-posts to X without human | Post confirm required |
| Full computer use / OS control | Chrome session only |
| Full SOC | Wrong product class |
| Native messaging parity with Claude/Codex | HTTP poll bridge, different architecture |

## Recommended wording

> **browser-leash** is a local Chrome session control plane: sticky arm, host allowlist, receipts, and human confirm on publish — not ambient RPA and not auto-post.
