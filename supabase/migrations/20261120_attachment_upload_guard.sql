-- Photo uploads to the public agent-attachments bucket: only a well-formed name in a hashed folder, at most 300
-- pictures per folder and 60 uploads an hour per network. This has been live since the security work in late
-- October (it was pasted straight into the SQL editor); this file brings the repo and setup.sql in step with it,
-- so a new install gets the same rule instead of the looser "any folder starting tk_agent_att_".
-- Every uploader already fits: renderer/js/agent-chat.js (<folder>/<uid>.jpg), agent/qwen-browser.js (stuck shots),
-- both with a 40-character hex folder (agent/worker-files.js folderFor). Safe to run more than once.

create table if not exists public.sync_upload_tries (
  ip_hash text,
  hour timestamptz,
  n integer default 0,
  primary key (ip_hash, hour)
);
alter table public.sync_upload_tries enable row level security;
revoke all on table public.sync_upload_tries from anon, authenticated;

create or replace function public.attachment_upload_allowed(p_name text)
returns boolean language plpgsql security definer set search_path = public as $$
declare folder text; cnt int;
begin
  if p_name is null or p_name !~ '^tk_agent_att_[0-9a-f]{40}/[A-Za-z0-9_-]{1,64}\.(jpg|jpeg|png|webp)$' then return false; end if;
  folder := split_part(p_name, '/', 1);
  begin
    select count(*) into cnt from storage.objects where bucket_id = 'agent-attachments' and name like folder || '/%';
    if cnt >= 300 then return false; end if;
  exception when others then null; end; -- cannot read the bucket's table here: the per-network cap still holds
  delete from public.sync_upload_tries where hour < now() - interval '1 day';
  insert into public.sync_upload_tries as u (ip_hash, hour, n)
    values (coalesce(public.sync_caller_ip_hash(), 'none'), date_trunc('hour', now()), 1)
    on conflict (ip_hash, hour) do update set n = u.n + 1
    returning u.n into cnt;
  return cnt <= 60;
end $$;
grant execute on function public.attachment_upload_allowed(text) to anon, authenticated, service_role;

drop policy if exists "agent attachments: app can upload" on storage.objects;
create policy "agent attachments: app can upload" on storage.objects for insert to anon
  with check (bucket_id = 'agent-attachments' and public.attachment_upload_allowed(name));
