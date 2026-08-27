Approved by Leo 2026-08-27 (chain IPO audit round 1, optimization 1; risk ruling: proceed with the loud-fail gate).

Problem: prompt assembly feeds every step ALL prior step outputs unconditionally (run-claim.ts:464-476, chainIndex < current). Measured on a 12-step chain: tail steps each swallow 76-105 KB of prior outputs (~19k-26k tokens), including a 42 KB spec delivered to steps that do not need it (librarian receives the full spec plus two review findings to sync docs). Estimated saving: 80k-100k tokens per compound chain, ~15k per direct chain.

Scope:
1. Each canonical template step declares which prior outputKinds it consumes; declaration lives in the template step definition (canonical Markdown frontmatter and TaskTemplateStep), not hardcoded.
2. Prompt assembly includes only declared kinds. A declared kind that is missing at claim time refuses the claim loudly (same pattern as spec-transcription refusals) - never assemble silently without it.
3. Curate the declarations for both seeded templates from each step's real input needs (fix step needs both review findings; regression needs the implementation summary; librarian needs the change summary, not the full spec).
4. Validate on a toy chain: walk all 12 steps and verify each prompt contains exactly the declared inputs.

Non-goals: changing step order, output schemas, or review isolation.

Acceptance: toy-chain walk shows per-step prompts carry only declared inputs; a dbtest covers the missing-declared-input refusal; measured tail-step prompt sizes drop consistently with the estimate; lint and tests green.
