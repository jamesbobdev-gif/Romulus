-- Files the local model's browser downloaded on its own computer (a worksheet off Blackboard) reach his other
-- computers through this bucket (agent/worker-files.js), so no device has to reach the mini PC: no SSH, no
-- Tailscale. Documents up to 25 MB. Like agent-attachments it is public and every file sits in a folder named by a
-- hash of the agent key (tk_agent_att_…), never the key itself; the app adds and removes files there with the
-- anon key, in that folder only. Paste this in the SQL editor of the project (supabase/setup.sql has it too).
insert into storage.buckets (id, name, public, file_size_limit)
  values ('agent-files', 'agent-files', true, 26214400)
  on conflict (id) do nothing;
drop policy if exists "agent files: app can upload" on storage.objects;
create policy "agent files: app can upload" on storage.objects for insert to anon
  with check (bucket_id = 'agent-files' and (storage.foldername(name))[1] like 'tk_agent_att_%');
drop policy if exists "agent files: app can see" on storage.objects;
create policy "agent files: app can see" on storage.objects for select to anon
  using (bucket_id = 'agent-files' and (storage.foldername(name))[1] like 'tk_agent_att_%');
drop policy if exists "agent files: app can remove" on storage.objects;
create policy "agent files: app can remove" on storage.objects for delete to anon
  using (bucket_id = 'agent-files' and (storage.foldername(name))[1] like 'tk_agent_att_%');
