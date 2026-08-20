-- Adds the Backlog column's status. This migration contains nothing else on
-- purpose: PostgreSQL permits `ALTER TYPE … ADD VALUE` inside a transaction but
-- forbids *using* the new value in that same transaction, and Prisma runs one
-- migration per transaction. Splitting removes that failure class entirely.
--
-- `BEFORE 'todo'` keeps the database's value order identical to the Prisma
-- datamodel's, where BACKLOG is declared first.
ALTER TYPE "TaskStatus" ADD VALUE 'backlog' BEFORE 'todo';
