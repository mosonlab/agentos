---
stepIndex: 9
layer: 8
agent: librarian
approvalGate: false
outputKind: documentation
priorOutputKinds: [implementation, fixed-implementation]
attachmentsFromPrevious: true
opensPullRequest: false
requiresCommit: false
baseFromStepIndex: null
spawnPolicy: null
---
Update internal documentation to match the delivered code. Persist exactly one JSON task output: `{"schemaVersion":1,"headSha":"<workspace HEAD>","summary":"<documentation result>","changes":[{"path":"<page path>","action":"ADDED|UPDATED|DELETED"}]}`; an empty changes array is valid when no wiki page needs modification.
