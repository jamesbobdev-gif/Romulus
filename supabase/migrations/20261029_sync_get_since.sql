-- sync_get takes the time of the caller's last pull (p_since). A row that hasn't changed since comes back
-- without its document (unchanged = true, doc null), so a poll of an unchanged list costs about a hundred
-- bytes instead of the whole list (the agent list is ~150 kB). Callers that send only p_sync_key (older
-- phone builds, settings.js's key rotation) get the full row as before.
-- Why: the free plan's 5 GB/month of egress ran out on 2026-10-28 (HTTP 402 on every call) from full
-- documents on every 30-second poll. renderer/js/sync.js and agent/supabase.js send p_since and keep the
-- last document they saw. (Applied to the live project 2026-10-29.)

drop function if exists public.sync_get(text);
create or replace function public.sync_get(p_sync_key text, p_since timestamptz default null)
returns table(doc jsonb, updated_at timestamptz, topic text, unchanged boolean)
language sql stable security definer
set search_path = public
as $$
  select case when p_since is not null and s.updated_at = p_since then null else s.doc end,
         s.updated_at,
         public.sync_topic_of(p_sync_key),
         (p_since is not null and s.updated_at = p_since)
  from (select 1) x left join public.tasks_sync s on s.sync_key = p_sync_key
  where length(p_sync_key) >= 16;
$$;
revoke all on function public.sync_get(text, timestamptz) from public;
grant execute on function public.sync_get(text, timestamptz) to anon, authenticated, service_role;
