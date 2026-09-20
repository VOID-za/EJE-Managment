-- Job number allocation.
--
-- The demo keeps `nextJobSequence` in the settings row and increments it. That
-- cannot be made safe: two Masters raising a job in the same moment both read
-- the same value and both get the same number. `SELECT max(job_number) + 1` has
-- the same defect with extra steps, and a client-generated number has it with no
-- steps at all.
--
-- A sequence is the answer PostgreSQL already has. `nextval` is atomic, never
-- hands the same value to two callers, and does not block — a transaction that
-- rolls back leaves a gap in the numbering, which is the correct trade: a gap is
-- a number nobody used, while a duplicate is two job cards claiming to be the
-- same job.
--
-- The sequence starts at 1068 because the demonstration data runs EJE-1039 to
-- EJE-1067, so production numbering continues rather than restarting and
-- colliding with identifiers the tests and the demo already use.

CREATE SEQUENCE IF NOT EXISTS eje_job_number_seq
  AS integer
  START WITH 1068
  INCREMENT BY 1
  NO CYCLE;
--> statement-breakpoint

-- Allocates the next job number, formatted as the business writes it.
--
-- Returns both halves: the numeric sequence value, which is what the job is
-- ordered by, and the display string. The prefix comes from the settings row so
-- EJE can change it without a migration.
CREATE OR REPLACE FUNCTION allocate_job_number(OUT seq integer, OUT job_number text)
LANGUAGE plpgsql
AS $$
DECLARE
  prefix text;
BEGIN
  SELECT s.job_number_prefix INTO prefix FROM system_settings s WHERE s.id = 1;
  IF prefix IS NULL THEN
    prefix := 'EJE-';
  END IF;

  seq := nextval('eje_job_number_seq');
  job_number := prefix || seq::text;
END;
$$;
--> statement-breakpoint

-- Moves the sequence forward, never backward.
--
-- Used once at go-live to set the starting number, and by the import tooling if
-- reference data arrives carrying higher numbers. Refusing to move backward is
-- the point: lowering it would hand out numbers that already exist.
CREATE OR REPLACE FUNCTION advance_job_number_sequence(target integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  current_value integer;
BEGIN
  SELECT last_value INTO current_value FROM eje_job_number_seq;

  IF target <= current_value THEN
    RETURN current_value;
  END IF;

  PERFORM setval('eje_job_number_seq', target, false);
  RETURN target;
END;
$$;
