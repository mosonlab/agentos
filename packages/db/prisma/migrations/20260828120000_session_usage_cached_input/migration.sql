-- Normalize the historical Claude and PI rows into the cached-inclusive
-- Session usage contract. Their old adapters stored inputTokens without the
-- cached subset; Codex already stored the cached-inclusive value.
--
-- Prisma applies this file in one transaction. Every refusal is raised before
-- the UPDATE, so a row that cannot be converted leaves the whole database
-- unchanged instead of being silently nulled or reinterpreted.

DO $$
BEGIN
  -- Use bigint for the check so PostgreSQL cannot overflow while evaluating
  -- the guard itself. A NULL input has no value to convert, and a NULL total
  -- has no value to convert; both remain NULL.
  IF EXISTS (
    SELECT 1
    FROM "Session"
    WHERE "runner"::text IN ('claude', 'pi')
      AND "cachedInputTokens" IS NOT NULL
      AND "cachedInputTokens" <> 0
      AND "inputTokens" IS NOT NULL
      AND (
        ("inputTokens"::bigint + "cachedInputTokens"::bigint) NOT BETWEEN -2147483648 AND 2147483647
        OR (
          "totalTokens" IS NOT NULL
          AND ("totalTokens"::bigint + "cachedInputTokens"::bigint) NOT BETWEEN -2147483648 AND 2147483647
        )
      )
  ) THEN
    RAISE EXCEPTION
      'session usage normalization: converted inputTokens or totalTokens exceeds INTEGER range';
  END IF;

  UPDATE "Session"
  SET
    "inputTokens" = "inputTokens" + "cachedInputTokens",
    "totalTokens" = CASE
      WHEN "totalTokens" IS NULL THEN NULL
      ELSE "totalTokens" + "cachedInputTokens"
    END
  WHERE "runner"::text IN ('claude', 'pi')
    AND "cachedInputTokens" IS NOT NULL
    AND "cachedInputTokens" <> 0
    AND "inputTokens" IS NOT NULL;
END;
$$;
