-- 2026-11-02 (security review): the caps the review put on the photo bucket (20261102_sync_hardening.sql), for the
-- agent-files bucket from 20261101_agent_files_bucket.sql, which took any number of anonymous uploads of up to 25 MB.
-- Paste it in the SQL editor of the project; supabase/setup.sql carries the same. Safe to run again.

-- ── the local model's downloads bucket (20261101_agent_files_bucket.sql): the same caps as the photo attachments ──
-- A folder shaped like the app's (the hash of the agent key), a plain file name, at most 300 files in a folder and at most
-- 60 uploads per network-hour (the counter is shared with agent-attachments), so the anon key alone can't fill the bucket.
create or replace function public.agent_file_upload_allowed(p_name text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare folder text; cnt int;
begin
  if p_name is null or p_name !~ '^tk_agent_att_[0-9a-f]{40}/[A-Za-z0-9][A-Za-z0-9 ._()-]{0,119}$' then return false; end if;
  folder := split_part(p_name, '/', 1);
  begin
    select count(*) into cnt from storage.objects where bucket_id = 'agent-files' and name like folder || '/%';
    if cnt >= 300 then return false; end if;
  exception when others then null; end;
  delete from public.sync_upload_tries where hour < now() - interval '1 day';
  insert into public.sync_upload_tries as u (ip_hash, hour, n)
    values (coalesce(public.sync_caller_ip_hash(), 'none'), date_trunc('hour', now()), 1)
    on conflict (ip_hash, hour) do update set n = u.n + 1
    returning u.n into cnt;
  return cnt <= 60;
end $$;
revoke all on function public.agent_file_upload_allowed(text) from public;
grant execute on function public.agent_file_upload_allowed(text) to anon, authenticated, service_role;
drop policy if exists "agent files: app can upload" on storage.objects;
create policy "agent files: app can upload" on storage.objects for insert to anon
  with check (bucket_id = 'agent-files' and public.agent_file_upload_allowed(name));
