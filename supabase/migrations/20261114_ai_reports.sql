-- Reports of AI replies (renderer/js/ai-report.js). Google Play's rule for apps that show AI-generated content asks for a
-- way, inside the app, to flag offensive output; the Report link under each AI reply sends that one reply here.
--   * what's stored: which AI (via/model), the reply's text (up to 6000 characters), the reason picked, when, and a
--     hash of the network it came from (to limit spam). No sync key, task or account.
--   * nobody can read the table through the API; the owner reads it in the dashboard (Table editor → ai_reports).
--   * each network may send 20 reports a day; past that the call fails 'report_limit'.
--   * reports are kept 180 days, then removed by the next report that comes in.
-- Paste it all in the SQL editor and press Run. It doesn't touch sync_put / sync_set / sync_usage.

create table if not exists public.ai_reports (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  via     text not null default '',
  model   text not null default '',
  reason  text not null default 'other',
  reply   text not null default '',
  ip_hash text
);
create index if not exists ai_reports_ip_day on public.ai_reports (ip_hash, at);
alter table public.ai_reports enable row level security;
revoke all on table public.ai_reports from anon, authenticated;
revoke all on sequence public.ai_reports_id_seq from anon, authenticated;

create or replace function public.ai_report(p_via text, p_model text, p_reply text, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  ip text := public.sync_caller_ip_hash();
  n int;
begin
  if coalesce(length(trim(p_reply)), 0) = 0 then raise exception 'empty_report'; end if;
  if ip is not null then
    select count(*) into n from public.ai_reports where ip_hash = ip and at > now() - interval '1 day';
    if n >= 20 then raise exception 'report_limit' using hint = 'this network sent 20 reports today'; end if;
  end if;
  delete from public.ai_reports where at < now() - interval '180 days';
  insert into public.ai_reports (via, model, reason, reply, ip_hash)
  values (left(coalesce(p_via, ''), 40), left(coalesce(p_model, ''), 120),
          case when p_reason in ('offensive', 'harmful', 'sexual', 'wrong', 'other') then p_reason else 'other' end,
          left(p_reply, 6000), ip);
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.ai_report(text, text, text, text) from public;
grant execute on function public.ai_report(text, text, text, text) to anon, authenticated;
