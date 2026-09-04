Deploy: a malformed install manifest is refused with an error naming the file and the field

Goal: an installer that reads a manifest it cannot use stops with a named error that says which manifest and which field, on both platforms.

Background: the Linux path reads manifests through `readJsonFile(path, reason)`
(`scripts/deploy/install-launchd.mjs:887-890`), which wraps `readFileSync` and
`JSON.parse` and rethrows the named reason
(`systemd-service-manifest-invalid`). The Darwin path does not: both callers of
`validateServiceManifest` (`install-launchd.mjs:2090` on revert, `:2129` on
install) call `JSON.parse(readFileSync(manifestPath, "utf8"))` inline, so an
unparseable file surfaces as a bare `SyntaxError` without the path.
`validateServiceManifest` (`:1993-2011`) checks that `entries` and
`retiredEntries` are arrays but not that their elements are objects; line 2007
reads `entry.pendingInstall` on each element, so a `null` or primitive element
throws `TypeError: Cannot read properties of null` with neither the manifest
path nor the field. The Linux validator has the same element gap. This is
finding 1 of the PR #454 review; finding 2 (re-bootstrapping units already
retired when a later step fails) is not adopted: #454 fixed the rule that a
partial shrink leaves the manifest describing what is installed and a second
run finishes the retirement, and resurrecting retired units would let them
claim Runs under identities the new inventory does not know.

Changes:
1. Every manifest read on the Darwin path goes through the same helper as the
   Linux path, so an unreadable or unparseable file fails with
   `launchd-service-manifest-invalid` and the message names the manifest path.
2. `validateServiceManifest` and its Linux counterpart validate each element of
   `entries` and `retiredEntries` (object, required string fields `label` and
   `path`, `pendingInstall` absent or `true`) and refuse with the platform's
   `*-service-manifest-invalid` reason, the message naming the manifest path,
   the array, the index, and the offending field.
3. `renderInputs` validation (`runnerCount`, `runnerIdPrefix`) reports the
   offending field name the same way when the value is missing or of the wrong
   type, instead of letting `inventoryForCount` throw.

Out of scope:
- Any change to shrink, grow, retire, or revert sequencing on either platform,
  including the re-bootstrap behaviour discussed in the #454 review.
- New error classes; the existing string-reason convention
  (`launchd-service-manifest-invalid`, `systemd-service-manifest-invalid`,
  `DeployFailure(reason, path)`) is kept.
- Manifest schema versioning or migration of older manifests.

Constraints:
- A valid manifest produced by the current installer is accepted unchanged on
  both platforms; the Darwin baseline fixture is neither regenerated nor edited.
- No `TypeError` or `SyntaxError` escapes a manifest read on either platform.

Acceptance:
1. `scripts/deploy/systemd-installer.test.mjs` has cases for both platforms
   where the manifest file is unparseable, where `entries` contains `null`,
   where an entry lacks `path`, and where `renderInputs.runnerCount` is a
   string; each fails with the platform's `*-service-manifest-invalid` reason
   and a message containing the manifest path and the field, and none throws
   `TypeError` or `SyntaxError`.
2. The existing shrink, grow, revert, and baseline-fixture tests pass
   unmodified.
3. `npm run test:auto-deploy` and the `scripts/deploy` suites are green.