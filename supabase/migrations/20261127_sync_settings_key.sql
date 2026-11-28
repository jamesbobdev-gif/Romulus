-- The ':settings' side row next to the personal list (renderer/js/shared-settings.js): the settings every device
-- shares: the look (light / dark / custom and the custom CSS), which tabs show, the Kitchen week plan, the EBT
-- switch. Like 20261119_sync_kitchen_key.sql, this takes the live definition of every function that checks the
-- side-row names and adds 'settings' after the last name in it. Running it twice changes nothing.
-- Paste it all in the SQL editor and press Run. Until then each device keeps its own settings, as before.

do $$
declare
  f text;
  d text;
  last text;
begin
  foreach f in array array['public.sync_put(text,jsonb,timestamptz)', 'public.sync_set(text,jsonb)', 'public.sync_usage(text)'] loop
    if to_regprocedure(f) is null then continue; end if;
    d := pg_get_functiondef(to_regprocedure(f));
    if position('|settings))' in d) > 0 then continue; end if;
    foreach last in array array['kitchen', 'macros', 'health', 'devices'] loop
      if position('|' || last || '))' in d) > 0 then
        execute replace(d, '|' || last || '))', '|' || last || '|settings))');
        exit;
      end if;
    end loop;
  end loop;
end $$;
