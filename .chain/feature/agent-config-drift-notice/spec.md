Problem
Canonical sync preserves runtimeConfigCustomized overrides, but when the canonical runner/model changes the resulting production drift is silent. The merge-resolver previously remained on claude-opus-5:medium while canon expected gpt-5.6-sol:high, and the difference was discovered only by accident.

Scope
- When canonical sync finds runner or model drift on an Agent whose runtimeConfigCustomized flag is true, create one Inbox notification naming the Agent, canonical value, production value, and customization flag.
- Notify only. Never overwrite the customization.
- Deduplicate unchanged drift across repeated syncs; notify again only when either side of the comparison changes after the prior notice.
- Keep task-creation status support out of this card; it has its own Backlog brief.

Acceptance
- DB tests cover first notification, unchanged-drift dedupe, changed-drift notification, and no overwrite.
- A non-customized canonical transition continues to adopt the registered default without a drift notice.
- Targeted DB tests, typecheck, and lint pass.

Route: implementation=senior-dev