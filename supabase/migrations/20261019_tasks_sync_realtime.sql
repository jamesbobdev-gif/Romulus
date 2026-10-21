-- Devices hear about list changes the moment they happen (renderer/js/sync.js → Realtime),
-- instead of waiting for the next 30-second check.
alter publication supabase_realtime add table public.tasks_sync;
