---
id: 01-authoring-refusal-envelope
title: Authoring refusal type and 404/409/422 envelope
blocked_by: []
risk: false
---

# 01: Authoring refusal type and 404/409/422 envelope

**What to build:** Prefactor. A template-authoring refusal that every later slice throws and the API renders without further plumbing: a distinct refusal class (separate from the instantiation refusal) carrying the complete authoring code union from the spec (`template_not_in_project`, `template_name_taken`, `template_name_reserved`, `template_canonical`, `template_in_use`, the eleven validator error codes) plus an optional `stepIndex`. The shared refusal-to-response mapping learns the new codes: `404` for `template_not_in_project`, `409` for the four state and name conflicts, `422` for every validator code, with the wire body `{ "error": <message>, "code": <code> }` and `"stepIndex"` present only when the refusal carries one. The refusal status union is widened to admit `422`. The `onError` path already renders anything the mapping knows, so once this lands a route only has to throw. No route, no validator logic and no persistence changes here; this slice exists so that slices 02 and 03 can run in parallel without both inventing the same type.

**Blocked by:** None (can start immediately)

- [ ] `refusalFor` recognises the authoring refusal and yields `code` (and `stepIndex` when set) in `detail`; verified by new cases in the existing `refusal` unit test.
- [ ] `refusalResponse` answers `404` for `template_not_in_project`, `409` for `template_canonical`, `template_in_use`, `template_name_taken`, `template_name_reserved`, and `422` for each of the eleven validator codes; the exhaustive `never` switch still compiles with the widened union; verified by the same unit test plus `npm run lint`.
- [ ] Instantiation refusal codes and their `400` statuses are unchanged; verified by the existing `refusal` and `templates` unit tests staying green.
