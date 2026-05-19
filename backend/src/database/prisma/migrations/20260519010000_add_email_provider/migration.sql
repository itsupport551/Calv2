-- Migration: add emailProvider enum and column to users table
CREATE TYPE "EmailProvider" AS ENUM ('AUTO', 'GOOGLE', 'MICROSOFT', 'SENDGRID');
ALTER TABLE "users" ADD COLUMN "emailProvider" "EmailProvider" NOT NULL DEFAULT 'AUTO';
