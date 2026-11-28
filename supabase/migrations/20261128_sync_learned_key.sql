-- The ':learned' side row next to the agent list (agent/learned-sync.js): what the Agent learned on one computer,
-- for his other computers: how-tos, site tips, the class log and which lane does which kind of task well.
-- Like 20261127_sync_settings_key.sql, this takes the live definition of every function that checks the
-- side-row names and adds 'learned' after the last name in it. Running it twice changes nothing.
-- Paste it all in the SQL editor and press Run. Until then each computer keeps what it learned to itself, as before.

do $$
declare
  f text;
  d text;
  last text;
begin
  foreach f in array array['public.sync_put(text,jsonb,timestamptz)', 'public.sync_set(text,jsonb)', 'public.sync_usage(text)'] loop
    if to_regprocedure(f) is null then continue; end if;
    d := pg_get_functiondef(to_regprocedure(f));
    if position('|learned))' in d) > 0 then continue; end if;
    foreach last in array array['settings', 'kitchen', 'macros', 'health', 'devices'] loop
      if position('|' || last || '))' in d) > 0 then
        execute replace(d, '|' || last || '))', '|' || last || '|learned))');
        exit;
      end if;
    end loop;
  end loop;
end $$;
