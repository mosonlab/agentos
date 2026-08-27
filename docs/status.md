# Release-candidate evidence status

The labels below describe the evidence recorded in this repository; they are
not compatibility promises by the CLI providers.

- **Verified**: exercised runtime or repository evidence exists for the stated
  path.
- **Maintainer-verified**: a maintainer exercised the stated path on the named
  platform, but the clean-machine reproduction gate is still open.
- **Experimental**: implemented enough for development evaluation, without a
  support commitment.
- **Pending**: required evidence has not been completed. Do not infer support.
- **Unverified**: no qualifying evidence has been recorded.
- **Unsupported**: outside the supported target.

### Provider support

| Provider runtime | Status | Evidence boundary |
| --- | --- | --- |
| Codex CLI | **Verified** | Adapter/runtime and subscription authentication path are verified. Clean fresh-install evidence is **Pending (OSS-B)**. |
| Claude Code | **Verified** / **Maintainer-verified** | Adapter/runtime is verified. Claude Pro/Max authentication is maintainer-verified on macOS Apple Silicon. The clean-install gate is **Pending (OSS-B)**. |
| Pi | **Verified** | Adapter/runtime and subscription authentication path are verified. Pi authenticates through the Codex login; it does not accept a Claude Code login. Clean fresh-install evidence is **Pending (OSS-B)**. |

Provider CLIs, accounts, authentication, subscriptions, usage allowances, rate
limits, models, and provider-side availability remain the user's responsibility.
AgentOS does not supply provider credentials or entitlement.

### Platform support

| Platform | Status | Evidence boundary |
| --- | --- | --- |
| macOS on Apple Silicon | **Target platform** | Current maintainer evidence includes Claude Pro/Max authentication; the complete clean fresh-install gate remains **Pending (OSS-B)**. |
| Linux | **Unverified** | Do not infer support from the Node.js codebase. |
| Windows | **Unsupported** | The current runner relies on POSIX process-group, path, and command behavior. |

### Feature surface

| Feature | Status | Evidence boundary |
| --- | --- | --- |
| Goals | **Pending** | The control plane stores a Goal, its Definition of Done, its progress log, and its limits, and the console edits them. No execution model is wired: nothing schedules work from a Goal, nothing measures its spend, and nothing stops it on spend, time, or stall. The console therefore renders no spend figure and no stopped state, because the server has no writer for either. |

