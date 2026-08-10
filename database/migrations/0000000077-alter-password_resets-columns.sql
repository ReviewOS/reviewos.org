ALTER TABLE "password_resets" ADD COLUMN IF NOT EXISTS "expires_at" timestamp;
