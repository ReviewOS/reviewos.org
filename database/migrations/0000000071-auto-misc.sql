ALTER TABLE "query_logs" ALTER COLUMN "query" TYPE text USING "query"::text;
ALTER TABLE "query_logs" ALTER COLUMN "normalized_query" TYPE text USING "normalized_query"::text;
ALTER TABLE "query_logs" ALTER COLUMN "error" TYPE text USING "error"::text;
ALTER TABLE "query_logs" ALTER COLUMN "bindings" TYPE text USING "bindings"::text;
ALTER TABLE "query_logs" ALTER COLUMN "trace" TYPE text USING "trace"::text;
