# Support

AgentOS v0.3.0 is a **Developer Preview**. This page says what that means in
practice, so that you can decide what to expect before you need it.

## What is supported

One platform, one shape of install: macOS on Apple Silicon, run from a `git
clone` of a released commit, on loopback, by the machine's own operator, against
repositories you are willing to have an agent write to.

[`docs/release/support-matrix.md`](docs/release/support-matrix.md)
is the authoritative statement of what is Verified, Maintainer-verified,
Experimental, Unverified and Unsupported, with the evidence boundary for each
row. Nothing outside that matrix is supported, including Linux, Windows, remote
access, production data, and any deployment shape other than the one the
quickstart walks.

## Before you ask

Most refusals in AgentOS are deliberate and name themselves. Reading the message
is usually faster than anything else:

- The console, the API and the migration paths print stable reason codes rather
  than values — `STOP release-migrate <condition>: <reason>`, `STOP preflight
  <condition>: <detail>`, or a startup line naming the environment variables at
  fault.
- [`docs/release/developer-preview.md`](docs/release/developer-preview.md)
  has a "When something refuses" table covering the common ones, including the
  upgrade case where an older `.env` no longer satisfies the current startup
  checks.
- [`docs/release/migration-and-recovery.md`](docs/release/migration-and-recovery.md)
  lists every migration refusal condition and what it means, and states plainly
  what recovery this release does and does not give you.

## Where to ask

Open a GitHub issue on this repository. Include the release tag or commit, your
macOS and Node.js versions, the exact command you ran, and the exact reason code
or message you got. Redact nothing except credentials — the reason codes are
designed to carry no values, so pasting them verbatim is safe.

For anything security-related, use the private channel in
[`SECURITY.md`](SECURITY.md) instead of an issue.

## What to expect

This is maintained by one team alongside other work. There is no service-level
agreement, no guaranteed response time, and no paid support tier. Issues are read;
not all of them will be fixed, and some will be closed as documented limitations
with a pointer to where the limitation is written down.

## What is explicitly not supported

- Running the Developer Preview against data you cannot afford to lose. There is
  no down migration and no supported restore path.
- Upgrading from one preview build to another. A fresh install is the only path.
- Any exposure beyond `127.0.0.1`.
- Rotating the secret encryption key while encrypted rows exist. It destroys them
  unrecoverably, and no command is provided to do it.
- Provider accounts, subscriptions, plan limits, rate limits and availability.
  AgentOS orchestrates coding CLIs you already installed and signed into; your
  relationship with their vendor is yours.
