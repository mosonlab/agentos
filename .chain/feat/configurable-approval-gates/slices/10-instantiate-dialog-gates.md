---
id: 10-instantiate-dialog-gates
title: "Instantiate dialog gate choices, pre-filled and change-only"
blocked_by: [03-project-gate-defaults, 06-instantiate-gate-resolution]
risk: true
---

# 10: Instantiate dialog gate choices, pre-filled and change-only

**What to build:** In template dispatch mode, show one checkbox for each slot
the selected template actually has and pre-fill it from that project’s default.
Hide absent slots. Track initial and current values so the instantiate request
contains only changed gate keys and omits `gates` entirely when nothing differs,
including after a toggle is changed and restored. Add complete English and
Chinese copy. The server’s missing-slot refusal remains authoritative.

**Blocked by:** 03-project-gate-defaults, 06-instantiate-gate-resolution

## Acceptance

- [ ] A compound template shows both checkboxes with one on and one off exactly
  as fetched; a direct template shows only merge; a template with neither slot
  shows neither.
- [ ] Dispatch with untouched values omits `gates`; changing one sends only that
  key; restoring it to the initial value omits `gates` again.
- [ ] Switching project or template resets both initial and current values to the
  newly selected context without leaking an earlier override.
- [ ] Both checkbox labels are present in English and Chinese.

## Verification

- New web test: `apps/web/src/tests/instantiate-gates.test.tsx` —
  `RUNNER_WORKSPACE_ROOT="$(mktemp -d)" TSX_TSCONFIG_PATH=apps/web/tsconfig.app.json node --conditions=development --import tsx --test apps/web/src/tests/instantiate-gates.test.tsx`
- Existing locale sweep: `apps/web/src/tests/i18n-sweep.test.tsx` —
  `RUNNER_WORKSPACE_ROOT="$(mktemp -d)" TSX_TSCONFIG_PATH=apps/web/tsconfig.app.json node --conditions=development --import tsx --test apps/web/src/tests/i18n-sweep.test.tsx`
- Scoped controls: `npm run typecheck -w @anneal/web` and
  `npm run lint -w @anneal/web`.
