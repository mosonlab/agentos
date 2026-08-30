-- A clean session that leaves its branch at the starting commit is distinct
-- from an agent failure and from delivery plumbing failures.
ALTER TYPE "FailureClass" ADD VALUE 'no-changes-produced' BEFORE 'task-failed';
