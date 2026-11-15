-- The attachments-cleanup function (supabase/functions/attachments-cleanup) lists every folder of two buckets each
-- time it runs, and anyone could run it as often as they liked: its "once in ten minutes" lived in the function's
-- own memory, which every cold start and every parallel instance begins afresh. Now the gap is kept here, in one
-- row, and a run first claims it: the first call in ten minutes does the work, the rest answer at once.
-- Run after 20261121_table_grants.sql.

alter table public.sync_settings add column if not exists attachments_cleaned_at timestamptz;

-- true for the one caller that may run the cleanup now (the last run is older than p_gap_s seconds); false for the rest
create or replace function public.sync_attachments_cleanup_claim(p_gap_s int)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare n int;
begin
  update public.sync_settings set attachments_cleaned_at = now()
    where id and (attachments_cleaned_at is null or attachments_cleaned_at < now() - make_interval(secs => greatest(coalesce(p_gap_s, 600), 60)));
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke all on function public.sync_attachments_cleanup_claim(int) from public;
revoke execute on function public.sync_attachments_cleanup_claim(int) from anon, authenticated;
grant execute on function public.sync_attachments_cleanup_claim(int) to service_role;
