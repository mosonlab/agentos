Problem
The auto-deploy pipeline escalates on remote-main-unreadable and never self-heals. In practice this failure is almost always a transient proxy flap (Clash, port 443), yet every occurrence halts auto-deploy until an operator manually runs --clear-escalation. This is a recurring fixed operational tax.

Scope
- Classify remote-main-unreadable as a potentially transient network failure. Before escalating, retry the remote read a bounded number of times with backoff.
- If an escalation of this class is already latched and a later scheduled cycle reads remote main successfully, clear that escalation automatically and record one audit entry naming the escalation, the failed window, and the clearing read.
- Only this failure class self-clears. Genuine repository corruption, auth failures, and persistent unreachability past the retry budget still escalate loudly and stay latched for manual clearing.
- No silent swallowing: every retry burst and every auto-clear is observable in the deploy log or audit trail.

Acceptance
- Tests cover: transient flap recovers without escalation; flap past the retry budget escalates; a latched transient escalation self-clears on the next successful read with an audit entry; corruption-class failures never self-clear.
- Typecheck and lint pass.

Route: implementation=senior-dev