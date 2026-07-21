-- ============================================================================
-- Effyra – Löschfrist für inaktive Konten (Art. 5 Abs. 1 lit. e DSGVO)
-- ============================================================================
-- Anlass: Bis 21.07.2026 gab es KEINE Frist. In DATENFLUSS.md stand der nie
-- ersetzte Platzhalter "X Monate nach Kündigung/Inaktivität", und die
-- Datenschutzerklärung sagte lediglich "bis zur Löschung deines Kontos" –
-- also: nie, wenn niemand etwas tut. Damit lagen Gesundheitsdaten verwaister
-- Konten unbefristet auf dem Server. Der Grundsatz der Speicherbegrenzung
-- verlangt eine Dauer oder wenigstens Kriterien für ihre Festlegung.
--
-- FESTGELEGT:
--   24 Monate ohne Aktivität  -> Löschung
--   davor, nach 23 Monaten    -> Vorwarnung per E-Mail, 30 Tage Frist
--
-- Sicherheitsnetz: Gelöscht wird ausschließlich, wer nachweislich gewarnt
-- wurde (deletion_warned_at gesetzt und mindestens 30 Tage her). Schlägt der
-- Mailversand fehl oder ist kein Schlüssel hinterlegt, unterbleibt die
-- Warnung – und damit auch die Löschung. Der Fehlerfall führt also zu
-- "nichts passiert", nie zu "still gelöscht".
--
-- Ausführen im Supabase SQL-Editor.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Aktivität festhalten.
--    auth.users.last_sign_in_at genügt nicht: wer die App täglich nutzt,
--    "meldet sich an" wegen langlebiger Refresh-Token womöglich monatelang
--    nicht. Ein eigener Zeitstempel, den der Client beim Start setzt, bildet
--    tatsächliche Nutzung ab.
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists last_active_at    timestamptz;
alter table public.profiles add column if not exists deletion_warned_at timestamptz;

-- Bestandskonten: mit dem besten vorhandenen Anhaltspunkt füllen, damit nicht
-- am Tag der Einführung schlagartig alle als inaktiv gelten.
update public.profiles p
   set last_active_at = greatest(
         coalesce(p.last_active_at, p.created_at),
         coalesce((select u.last_sign_in_at from auth.users u where u.id = p.id), p.created_at),
         p.created_at)
 where p.last_active_at is null;

alter table public.profiles alter column last_active_at set default now();

create index if not exists profiles_last_active_idx on public.profiles (last_active_at);

-- ---------------------------------------------------------------------------
-- 2) Der Client meldet Aktivität.
--    Höchstens ein Schreibvorgang pro Tag und Konto – sonst wäre jeder
--    App-Start ein Update auf einer Tabelle, die sonst kaum geschrieben wird.
--    Eine erneute Aktivität löscht eine laufende Vorwarnung: Wer zurückkommt,
--    ist nicht mehr inaktiv.
-- ---------------------------------------------------------------------------
create or replace function public.touch_activity()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.profiles
     set last_active_at     = now(),
         deletion_warned_at = null
   where id = auth.uid()
     and (last_active_at is null or last_active_at < now() - interval '1 day');
end
$fn$;

revoke all on function public.touch_activity() from public, anon;
grant execute on function public.touch_activity() to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Welche Konten sind zu warnen, welche zu löschen?
--    Nur für den service_role-Aufruf aus der Aufräum-Function.
-- ---------------------------------------------------------------------------
create or replace function public.accounts_to_warn()
returns table (user_id uuid, email text, last_active_at timestamptz)
language sql
security definer
set search_path = public
as $fn$
  select p.id, coalesce(p.email, u.email), p.last_active_at
    from public.profiles p
    join auth.users u on u.id = p.id
   where p.last_active_at < now() - interval '23 months'
     and p.deletion_warned_at is null
     and coalesce(p.email, u.email) is not null
   limit 200
$fn$;

create or replace function public.accounts_to_delete()
returns table (user_id uuid)
language sql
security definer
set search_path = public
as $fn$
  select p.id
    from public.profiles p
   where p.last_active_at     < now() - interval '24 months'
     -- Ohne zugestellte Vorwarnung wird NICHT gelöscht.
     and p.deletion_warned_at is not null
     and p.deletion_warned_at < now() - interval '30 days'
   limit 200
$fn$;

create or replace function public.mark_warned(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.profiles set deletion_warned_at = now() where id = p_user;
end
$fn$;

revoke all on function public.accounts_to_warn()      from public, anon, authenticated;
revoke all on function public.accounts_to_delete()    from public, anon, authenticated;
revoke all on function public.mark_warned(uuid)       from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4) Täglich prüfen. Der eigentliche Ablauf steckt in der Edge Function
--    account-cleanup (Warnung per Brevo, Löschung über delete-account).
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare v_secret text;
begin
  -- Erste Quelle: der Vault.
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'CRON_SECRET' limit 1;

  -- Zweite Quelle: die bereits laufenden Cron-Jobs. Dort steckt der Schluessel
  -- im Klartext im Kommando, weil er beim Einrichten per format() eingesetzt
  -- wurde. Am 21.07.2026 war der Vault-Eintrag verschwunden, waehrend die
  -- vier bestehenden Jobs weiterliefen – ohne diesen Rueckgriff muesste der
  -- Betreiber den Schluessel heraussuchen und abtippen.
  if v_secret is null then
    select (regexp_match(command, 'x-cron-secret''\s*,\s*''([^'']+)'''))[1]
      into v_secret
      from cron.job
     where command like '%x-cron-secret%'
       and jobname <> 'effyra-konten-aufraeumen'
     limit 1;

    -- Gefundenen Schluessel in den Vault legen, damit die naechste Ausfuehrung
    -- ihn regulaer findet.
    if v_secret is not null
       and not exists (select 1 from vault.decrypted_secrets where name = 'CRON_SECRET') then
      perform vault.create_secret(v_secret, 'CRON_SECRET',
        'Gemeinsames Geheimnis fuer die Cron-Aufrufe der Edge Functions');
      raise notice 'CRON_SECRET fehlte im Vault und wurde aus einem bestehenden Job uebernommen.';
    end if;
  end if;

  -- Kein stiller Rueckzug: Ein fehlgeschlagener Einrichtungsschritt, der nur
  -- eine Notiz hinterlaesst, geht in der Ausgabe unter. Genau so blieb der Job
  -- am 21.07.2026 unbemerkt ungeplant – der Fehler waere erst in 23 Monaten
  -- aufgefallen, wenn die erste Vorwarnung ausbleibt.
  if v_secret is null then
    raise exception 'CRON_SECRET weder im Vault noch in einem bestehenden Cron-Job gefunden. Job NICHT geplant. Secret im Vault anlegen und erneut ausfuehren.';
  end if;

  perform cron.unschedule('effyra-konten-aufraeumen')
    where exists (select 1 from cron.job where jobname = 'effyra-konten-aufraeumen');

  perform cron.schedule(
    'effyra-konten-aufraeumen',
    '30 3 * * *',   -- taeglich 03:30 UTC, ausserhalb der Nutzungszeiten
    format($f$select net.http_post(
      url     := 'https://ocnlrxmosbbtsczjyvxb.supabase.co/functions/v1/account-cleanup',
      headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', '%s'),
      body    := '{}'::jsonb,
      timeout_milliseconds := 120000
    );$f$, v_secret)
  );
  raise notice 'effyra-konten-aufraeumen geplant (taeglich 03:30 UTC).';
end $$;
