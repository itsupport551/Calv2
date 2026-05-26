-- Link our users table to Supabase Auth users. Nullable for backfill;
-- new signups going through Supabase Auth set this on first login.
ALTER TABLE "users" ADD COLUMN "supabaseUserId" TEXT;
CREATE UNIQUE INDEX "users_supabaseUserId_key" ON "users"("supabaseUserId");
