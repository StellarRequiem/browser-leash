# browser-leash — public open-source readiness

**Decision status:** **DEFERRED** (local control plane today).  
This file is the prep checklist so a future public ship is architecture-ready, not a ship itself.

## What would become public

| Surface | Path | Notes |
|---------|------|-------|
| Bridge | `bridge/server.py`, `client.py` | Loopback-only HTTP |
| Extension | `extension/*` | Chrome MV3 + debugger permission |
| Docs | AGENT, PERMISSION_TIERS, CAPABILITY_GAP | Claim-safe language |

## Before any public repo

- [ ] Operator explicit “open-source browser-leash” ask  
- [ ] LICENSE chosen (Apache-2.0 matches mcp-assure)  
- [ ] `CLAIMS.md` (no auto-post / full CUA)  
- [ ] `THREAT_MODEL.md` (debugger = high trust; arm required)  
- [ ] PII scrub: no receipts/captures in git  
- [ ] Host allowlist defaults documented  
- [ ] README: sticky ARM, human Post confirm, not a product SOC  
- [ ] Version badge matches live smoke  

## Claim ceiling if public

> Local Chrome session control plane with sticky arm, host allowlist, and human confirm on publish — not auto-post, not full computer use.

## Not in scope for public

- Operator’s live host allowlist with personal domains only  
- Receipts/logs with session content  
- Guarantees about X React Post enable rates  
