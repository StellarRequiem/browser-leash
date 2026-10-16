# Constrained X own-post cleanup (batch-1 P1)

**Purpose:** Delete **your own** rude/offensive posts under human ARM — not ambient moderation.

## Rules

1. ARM required  
2. Only `x.com/<your-handle>/status/<id>` you own  
3. Menu must show **Delete** as first own-menu item (abort if not)  
4. Confirm dialog required  
5. Log IDs to a local results file  
6. Never delete others’ posts; never mass-report  

## Operator tooling

- Script: `~/ops/career/x_delete_posts.py` (curated ID list)  
- Results: `~/ops/career/X_DELETE_RESULTS.json`  
- Policy notes: `~/ops/career/X_PROFILE_CLEANUP_*.md`  

## Via agent-control

Navigate → caret on own article → Delete menuitem → `confirmationSheetConfirm`.  
Prefer subagent/batch under operator request only.

## Claim

Cleanup is operator-driven hygiene, not platform enforcement.
