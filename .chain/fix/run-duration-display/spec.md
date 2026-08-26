Feature brief:
Problem: observed 2026-08-21 on run cmt2swfsj0brumpjf299da7pt (Quiet-window auto-deploy: Apply review fixes). The run worked about 54 minutes, parked in waiting-inbox, and after resume the task detail showed Started = the resume moment and Duration = 8m. The pre-suspend work time disappeared from the UI, misleading the operator about how long the run actually worked.

What to build: first determine which layer owns the defect - either the runner/API overwrites the run startedAt on resume (data written wrong) or the stored data is correct and the web rendering derives Started/Duration from the wrong field. Fix at the layer that owns the truth, not by patching the display over wrong data.

Expected behavior:
- Started reflects run creation/first claim and is never overwritten by a resume.
- Duration is anchored to the run start (or cumulative active time) and suspended/waiting-inbox intervals are excluded or clearly annotated.
- Historical runs whose stored fields were already overwritten do not need retroactive repair; only stop the ongoing corruption or misrendering going forward.

Acceptance:
- A run that suspends into waiting-inbox and resumes shows a Started time equal to its original start and a Duration that does not reset to the post-resume interval.
- A targeted test covers the resume path at the owning layer (API data invariants or web derivation, whichever was at fault).
- Existing suites stay green; no silent fallback.
Persist the final implementation output for this step through the AgentOS task output endpoint.
