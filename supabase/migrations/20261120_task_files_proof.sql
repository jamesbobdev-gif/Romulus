-- Files on tasks (the task-files bucket, renderer/js/task-files.js): a proof of the account on every upload, and
-- only the kind of file the app sends.
-- Until now the bucket took an upload into any account's folder from anyone holding the app's publishable key
-- and the folder's name, which is in every file address and is handed to a group's owner for each member: five
-- 10 MB files filled a free account's space, its lists stopped syncing, and it could not list the bucket to clean
-- up. And nothing limited what kind of file went up, so a page could be hosted here under the project's address.
-- Now:
--   * the app registers, once per account, the hash of a proof it derives from its lookup id (the same id it
--     proves to sync_put; the proof is sha256('romulus-task-files-v1|' || id), and the server keeps sha256 of
--     that). From then on every upload into that folder must carry the proof in an x-romulus-proof header, which
--     the storage server hands to Postgres in request.headers. The key and the id never reach the storage server.
--   * an account that hasn't registered yet (an app older than this) is taken as before, so nothing breaks before
--     every device has updated; a later migration can make the proof a must for all.
--   * only application/octet-stream (what the app sends: ciphertext), and names shaped like the app's
--     (acct_<64 hex>/<24 url-safe characters>).
-- Run after 20261119_sync_kitchen_key.sql.

alter table public.sync_accounts add column if not exists files_proof text; -- sha256 (hex) of the account's upload proof

update storage.buckets set allowed_mime_types = array['application/octet-stream'] where id = 'task-files';

-- the app, once per account: here is sha256 of my proof. Set once; the same value again says yes, another says no.
create or replace function public.sync_files_proof_set(p_sync_key text, p_proof_hash text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare a text; cur text;
begin
  if p_sync_key is null or p_sync_key !~ '^tk_[A-Za-z0-9_-]{13,}(:[a-z-]+)?$' then return false; end if;
  if p_proof_hash is null or p_proof_hash !~ '^[0-9a-f]{64}$' then return false; end if;
  a := public.sync_account_of(p_sync_key);
  select files_proof into cur from public.sync_accounts where account = a;
  if not found then return false; end if;
  if cur is null then
    update public.sync_accounts set files_proof = p_proof_hash where account = a and files_proof is null;
    return true;
  end if;
  return cur = p_proof_hash;
end $$;
revoke all on function public.sync_files_proof_set(text, text) from public;
grant execute on function public.sync_files_proof_set(text, text) to anon, authenticated, service_role;

-- may this upload go in: the name's shape, the account's proof once it has one, and room (sync_files_room as before)
create or replace function public.sync_files_upload_allowed(p_name text)
returns boolean
language plpgsql stable security definer
set search_path = public, storage
as $$
declare folder text; acc public.sync_accounts; k text;
begin
  if p_name is null or p_name !~ '^acct_[0-9a-f]{64}/[A-Za-z0-9_-]{24}$' then return false; end if;
  folder := split_part(p_name, '/', 1);
  select * into acc from public.sync_accounts where account = substr(folder, 6);
  if not found then return false; end if;
  if acc.files_proof is not null then
    begin k := (nullif(current_setting('request.headers', true), '')::json)->>'x-romulus-proof'; exception when others then k := null; end;
    if k is null or k !~ '^[0-9a-f]{64}$' then return false; end if;
    if encode(sha256(convert_to(k, 'UTF8')), 'hex') <> acc.files_proof then return false; end if;
  end if;
  return public.sync_files_room(folder);
end $$;
revoke all on function public.sync_files_upload_allowed(text) from public;
grant execute on function public.sync_files_upload_allowed(text) to anon, authenticated, service_role;

drop policy if exists "task files: app can upload" on storage.objects;
create policy "task files: app can upload" on storage.objects for insert to anon
  with check (bucket_id = 'task-files' and public.sync_files_upload_allowed(name));
