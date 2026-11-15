-- Two tables the app's key could reach if a row-level security switch were ever flipped, and a default that hands
-- every new table and function to the app's key before anyone decides.
-- The site counter's tables (20261116_site_counts.sql) got row level security but kept the grants Supabase gives
-- every new table by default (select, insert, update, delete for anon and authenticated); the other tables had
-- those revoked. Row level security with no policies already lets nothing through; this takes the grants away
-- too, like the rest. And from now on a new table or function in public starts with no rights for the app's key:
-- a migration that forgets its grant then fails closed (the function can't be called) instead of open (anyone
-- with the publishable key can call it).
-- Run after 20261120_task_files_proof.sql.

revoke all on table public.site_counts, public.site_tries from anon, authenticated;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
