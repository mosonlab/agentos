# Runbook — add a project and open a pull request

This runbook covers the pull-request workflow that A1 installs. It stops at an
open pull request: the operator reviews and merges that pull request by hand.
It does not provision another workflow, create a Secret, or perform an
automatic merge.

## Prerequisites

Before calling the API, have all of the following ready:

- a supported GitHub remote for the repository you want Anneal to change;
- the GitHub CLI (`gh`) installed and authenticated under the account running
  the API; check it with `gh auth status`;
- the Codex, Pi, and Claude Code runtimes installed and authenticated. A1's
  four pull-request roles use those runtimes, so all three must be available
  even though a particular run may not exercise every provider on one host;
- the API's operator bearer in `OPERATOR_TOKEN`, and `jq` for extracting the
  ids returned by the API; and
- a Git identity and GitHub Git transport available to the API host. For a
  GitHub HTTPS remote, `gh auth setup-git` configures the authenticated Git
  helper used by the repository preflight. Under the same account and `HOME`
  used by the API preflight, confirm the global identity with
  `git config --global --get user.name` and
  `git config --global --get user.email`.

Set the local values for the commands below. Keep the remote exactly as a
supported GitHub URL; the Repo route validates the raw value and runs its
preflight before it writes anything.

```sh
export BASE_URL=http://127.0.0.1:3000
export PROJECT_NAME="Demo project"
export PROJECT_SLUG=demo-project
export REPO_NAME=demo
export REPO_REMOTE=https://github.com/acme/demo.git
export BRANCH_NAME=feature/demo
```

## Create the Project

Call `POST /projects` with a name and lowercase hyphenated slug. A1 creates
the Project in one bootstrap operation with its `local` Environment, the four
workflow Agents `senior-dev-luna`, `review-coordinator-sol`,
`review-coordinator-opus`, and `senior-dev`, and the canonical
`pr-engineer-workflow` TaskTemplate.

```sh
PROJECT_BODY=$(jq -n \
  --arg name "$PROJECT_NAME" \
  --arg slug "$PROJECT_SLUG" \
  '{"name":$name,"slug":$slug}')
PROJECT_JSON=$(curl --fail-with-body -sS -X POST "$BASE_URL/projects" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PROJECT_BODY")
PROJECT_ID=$(printf '%s' "$PROJECT_JSON" | jq -r '.id')
test -n "$PROJECT_ID" -a "$PROJECT_ID" != null
```

If the slug is already used, choose another slug and repeat the Project
request. Do not retry with a different spelling of the same existing Project.

## Add the repository and grants

Add the GitHub repository with `grantAgents: true`. The successful response is
`{ repo, grants }`; the four active A1 workflow Agents receive `GIT_WRITE`
access, and the mechanical integrator Agent is not granted access.

```sh
REPO_BODY=$(jq -n \
  --arg name "$REPO_NAME" \
  --arg remoteUrl "$REPO_REMOTE" \
  '{"name":$name,"remoteUrl":$remoteUrl,"defaultBranch":"main","dependencyProvisioning":"NPM_CI","grantAgents":true}')
REPO_JSON=$(curl --fail-with-body -sS -X POST "$BASE_URL/projects/$PROJECT_ID/repos" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$REPO_BODY")
REPO_ID=$(printf '%s' "$REPO_JSON" | jq -r '.repo.id')
test -n "$REPO_ID" -a "$REPO_ID" != null
```

Choose `NPM_CI` only for repositories whose default branch has a root `package-lock.json`; otherwise choose `NONE`.

If the response was not saved, obtain the created Repo id from the Project's
Repo list:

```sh
REPO_ID=$(curl --fail-with-body -sS -X GET "$BASE_URL/projects/$PROJECT_ID/repos" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  | jq -r --arg name "$REPO_NAME" '.[] | select(.name == $name) | .id' | tail -n 1)
```

The preflight uses the API host's ambient Git identity and credentials. It
does not read or decrypt a Secret supplied as `credentialSecretId`; configure
the host's GitHub transport before this call if the remote requires it.

## Instantiate A1's template

Fetch the Project's templates and select the canonical `pr-engineer-workflow`
id. The template declares the `branchName` variable.

```sh
TEMPLATE_ID=$(curl --fail-with-body -sS -X GET "$BASE_URL/projects/$PROJECT_ID/task-templates" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  | jq -r '.[] | select(.name == "pr-engineer-workflow") | .id')
test -n "$TEMPLATE_ID" -a "$TEMPLATE_ID" != null
```

Instantiate it with the created Repo and the branch to change. `autoStart: true`
queues the first step so the pull-request workflow begins immediately.

```sh
curl --fail-with-body -sS -X POST \
  "$BASE_URL/projects/$PROJECT_ID/task-templates/$TEMPLATE_ID/instantiate" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repoId":"'"$REPO_ID"'","variables":{"branchName":"'"$BRANCH_NAME"'"},"autoStart":true}'
```

The response contains the chain and task ids. Follow the task's pull-request
link (or inspect it with `gh`) after the four A1 roles finish:

```sh
gh auth status
GH_REPO=$(gh repo view "$REPO_REMOTE" --json nameWithOwner --jq '.nameWithOwner')
gh pr list --repo "$GH_REPO" --head "$BRANCH_NAME"
```

Review the resulting pull request, its checks, and its diff. Merge it by hand
in GitHub only after you are satisfied; this runbook does not invoke an
automatic merge.
