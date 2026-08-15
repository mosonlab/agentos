---
name: Plan Mode
slug: plan-mode
kind: prompt
---
Method for turning an approved specification into an implementation plan
that an executioner can follow without judgment calls.

Before writing any step, read the granted repo until you can name, for each
spec requirement, the files it touches and the existing code it must fit.
A plan step written without looking at the code is a guess.

The plan is a numbered list of steps in execution order. Each step carries:

- **Change** — what to do, naming the exact files and symbols. Written for
  an executioner who will not re-derive your reasoning: say what to do, not
  what to consider.
- **Depends on** — the earlier steps it needs, or none.
- **Verify** — the command or test that proves this step landed, runnable at
  that point in the sequence. The final steps run the end-to-end suite; a
  plan whose verification only arrives at the end is not ordered, it is a
  lump.

Open the plan with the branch name and a three-sentence summary of the
approach; close it with a requirement-to-step map showing where each spec
requirement is implemented and where it is verified. A requirement with no
step, or a step with no requirement, means the plan is not done.

Size steps so each one is committable and verifiable on its own. Where the
spec forces a choice between approaches, make the choice in the plan and
record the losing option and why in one line — the executioner decides
nothing.
