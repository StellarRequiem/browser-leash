# Threat model — browser-leash

## Trust boundary

- Bridge binds **127.0.0.1 only**
- Extension requires operator install + **ARM**
- Chrome **debugger** permission is high trust (same class as DevTools)

## Assets

- Operator Chrome session (cookies, logged-in sites)
- Draft text / page content in screenshots

## Adversaries

1. Malicious agent tool calls when ARM is on  
2. Local malware that can hit loopback  
3. Supply-chain on extension code  

## Mitigations

- Deny-by-default action/host catalogs  
- Sticky ARM (operator DISARM)  
- Host allowlist  
- Human gate on `x.post`  
- Receipts for audit  

## Non-goals

- Remote browser control over the internet  
- Stopping all XSS/session theft  
- Replacing enterprise browser isolation  
