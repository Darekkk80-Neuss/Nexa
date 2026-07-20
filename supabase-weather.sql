-- ============================================================
-- Effyra – Unwetter-Push: Spalten + Cron (alle 30 Min)
-- SELBST-KONFIGURIEREND: das CRON_SECRET wird automatisch aus einem
-- bestehenden Effyra-Cron übernommen – du musst nichts eintippen.
-- Voraussetzung: Edge Function "weather-push" ist deployt, supabase-push.sql
-- (push_subscriptions) wurde ausgeführt.
-- Im Supabase SQL-Editor komplett ausführen ("Run"). Mehrfach ausführbar.
-- ============================================================
--
-- WICHTIG: Diese Datei MUSS laufen, nachdem die neue weather-push deployt wurde.
-- Die Function prüft ab sofort das CRON_SECRET (vorher tat sie das NICHT und war
-- damit ein offener Endpunkt: jeder Aufruf las die gesamte Abo-Tabelle, feuerte
-- Bright-Sky-Abrufe und verschickte Pushes auf Betreiberkosten). Ein bereits im
-- Dashboard angelegter Cron ohne Header bekommt jetzt 403 – dieses Script legt
-- den Job mit Header neu an.

-- 1) Spalten für die Warn-Abos (einmalig, idempotent)
alter table public.push_subscriptions add column if not exists warn      boolean default false;
alter table public.push_subscriptions add column if not exists warn_lat  double precision;
alter table public.push_subscriptions add column if not exists warn_lon  double precision;
alter table public.push_subscriptions add column if not exists warn_last text;

-- Partieller Index: der Cron filtert auf warn = true.
create index if not exists push_subscriptions_warn_idx
  on public.push_subscriptions (user_id) where warn;

-- 2) Zeitplan
create extension if not exists pg_cron;

-- 2a) evtl. vorhandenen Job entfernen (auch einen ohne Header aus dem Dashboard)
do $$ begin perform cron.unschedule('effyra-weather'); exception when others then null; end $$;

-- 2b) Secret aus einem bestehenden, korrekt konfigurierten Cron übernehmen
do $$
declare
  v_secret text;
begin
  select (regexp_matches(command, $re$x-cron-secret'\s*,\s*'([^']+)'$re$))[1]
    into v_secret
    from cron.job
   where command like '%x-cron-secret%'
     and command not like '%<CRON_SECRET>%'
   limit 1;

  if v_secret is null then
    raise exception 'Kein CRON_SECRET in bestehenden Crons gefunden. Bitte zuerst supabase-morning.sql oder supabase-due-reminder.sql ausfuehren.';
  end if;

  perform cron.schedule(
    'effyra-weather',
    '*/30 * * * *',
    format($f$select net.http_post(
      url     := 'https://ocnlrxmosbbtsczjyvxb.supabase.co/functions/v1/weather-push',
      headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', '%s'),
      body    := '{}'::jsonb
    );$f$, v_secret)
  );
  raise notice 'effyra-weather geplant (alle 30 Min) mit uebernommenem CRON_SECRET.';
end $$;

-- Kontrolle:
--   select jobname, schedule, active from cron.job where jobname = 'effyra-weather';
--   select command from cron.job where jobname = 'effyra-weather';
