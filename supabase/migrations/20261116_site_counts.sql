-- The website's private counter (site/index.html): a tally per button per day of what visitors do on the
-- download page: 'view' (the page opened), 'download:windows' and the other platforms, 'plan:free',
-- 'plan:individual', 'plan:family', 'source' (the GitHub links). Counts only: no cookies, nothing per person,
-- and no IP address kept with them (the hourly limit keeps a hash of the IP for a day, as pairing does). The
-- page adds to it with the publishable key; reading it takes the service role, so the counts aren't public:
-- supabase/site-counts.sql, through `npx supabase db query --remote --yes --file supabase/site-counts.sql`,
-- or the SQL editor. Paste it all in the SQL editor and press Run.

create table if not exists public.site_counts (
  day   date not null,
  event text not null,
  n     bigint not null default 0,
  primary key (day, event)
);
alter table public.site_counts enable row level security; -- no policies: only the functions below reach it

-- one browser (by IP hash) may count 120 times an hour; past that its calls are dropped, not refused
create table if not exists public.site_tries (
  ip_hash text not null,
  hour    timestamptz not null,
  n       int not null default 0,
  primary key (ip_hash, hour)
);
alter table public.site_tries enable row level security;

create or replace function public.site_count(p_event text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare cnt int;
begin
  if p_event is null or p_event !~ '^(view|download|plan|source)(:[a-z0-9-]{1,24})?$' then return; end if;
  delete from public.site_tries where hour < now() - interval '1 day';
  insert into public.site_tries as t (ip_hash, hour, n)
    values (coalesce(public.sync_caller_ip_hash(), 'none'), date_trunc('hour', now()), 1)
    on conflict (ip_hash, hour) do update set n = t.n + 1
    returning n into cnt;
  if cnt > 120 then return; end if;
  insert into public.site_counts as c (day, event, n) values (current_date, p_event, 1)
    on conflict (day, event) do update set n = c.n + 1;
end $$;

-- the counts, newest day first (service role only)
create or replace function public.site_counts_read(p_days int default 30)
returns table(day date, event text, n bigint)
language sql stable security definer
set search_path = public
as $$ select c.day, c.event, c.n from public.site_counts c where c.day >= current_date - p_days order by c.day desc, c.n desc $$;

revoke all on function public.site_count(text), public.site_counts_read(int) from public;
grant execute on function public.site_count(text) to anon, authenticated, service_role;
revoke execute on function public.site_counts_read(int) from anon, authenticated;
grant execute on function public.site_counts_read(int) to service_role;
