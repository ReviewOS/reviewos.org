DO $stacks$
DECLARE existing record;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'deployments')
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'deployments' AND column_name = 'repository_id')
  THEN
    ALTER TABLE "deployments" RENAME TO "deployments_legacy";

    FOR existing IN SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'deployments_legacy' AND indexname NOT LIKE 'deployments\_legacy%' LOOP
      EXECUTE format('ALTER INDEX %I RENAME TO %I', existing.indexname, 'deployments_legacy' || substring(existing.indexname from 12));
    END LOOP;

    IF EXISTS (SELECT 1 FROM pg_sequences WHERE schemaname = current_schema() AND sequencename = 'deployments_id_seq') THEN
      ALTER SEQUENCE "deployments_id_seq" RENAME TO "deployments_legacy_id_seq";
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'migrations') THEN
      DELETE FROM "migrations" WHERE "migration" = '0000000208-create-deployments-table.sql';
    END IF;
  END IF;
END $stacks$;
