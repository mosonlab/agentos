-- Keep the claim-route deferred-release sweep on its narrow candidate history.
-- The hot query repeats this predicate as canonical SQL literals so PostgreSQL
-- can prove that its prepared statement is eligible for the partial index.
CREATE INDEX "TaskActivity_release_deferred_createdAt_id_idx"
ON "TaskActivity"("createdAt", "id")
WHERE "actorType" = 'control-plane'
  AND metadata->>'kind' = 'mergeTail.leaseRelease'
  AND metadata->>'state' = 'release-deferred'
  AND metadata->>'projectId' IS NOT NULL
  AND metadata->>'chainId' IS NOT NULL
  AND metadata->>'taskId' = "taskId";
