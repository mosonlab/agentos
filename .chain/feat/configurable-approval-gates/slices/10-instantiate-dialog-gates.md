---
id: 10-instantiate-dialog-gates
title: "Instantiate dialog gate checkboxes, pre-filled and change-only"
blocked_by: [03-project-gate-defaults, 06-instantiate-gate-resolution]
risk: false
---

# 10: Instantiate dialog gate checkboxes, pre-filled and change-only

**What to build:** When dispatching a chain from the web instantiate dialog, the
operator sees the gate decision before committing to it. In template mode the
dialog shows a checkbox per gate slot the selected template actually has —
pre-filled from the project's defaults — and hides checkboxes for slots the
template lacks, so the 400 refusal cannot be produced by accident (the server
refusal remains the authority). On dispatch, the POST body includes a key in
`gates` only for a value the operator changed from its pre-filled state; when
nothing changed, `gates` is omitted entirely, so the project default keeps
applying to anything left alone. Spec stories 12–13, the dialog surface of D11.

**Blocked by:** 03-project-gate-defaults, 06-instantiate-gate-resolution

- [ ] An `apps/web` test renders the dialog for a compound template on a project with one default on and one off, showing both checkboxes pre-filled to match; for a direct template only the merge checkbox renders; for a pull-request template neither renders.
- [ ] A harness test shows: dispatch with nothing touched omits `gates` from the POST body; toggling one checkbox sends `gates` with only that key; toggling a checkbox and toggling it back also omits `gates` (the tracked value equals its initial value).
- [ ] New strings exist in both locales; the i18n sweep test passes; `apps/web` typecheck and `npm run lint` pass on touched files.
