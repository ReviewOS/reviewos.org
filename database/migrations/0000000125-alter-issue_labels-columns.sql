ALTER TABLE "issue_labels" DROP CONSTRAINT IF EXISTS "issue_labels_label_id_fk";
ALTER TABLE "issue_labels" ADD CONSTRAINT "issue_labels_label_id_fk" FOREIGN KEY ("label_id") REFERENCES "repository_labels"("id");
