-- ============================================================
-- Effyra – Web-Push-Abos (Hintergrund-Benachrichtigungen)
-- Einmalig im Supabase SQL-Editor ausführen ("Run").
-- Kann gefahrlos mehrfach ausgeführt werden.
-- ============================================================

create table if not exists public.push_subscriptions (
  user_id    uuid not null references auth.users(id) on delete cascade,
  endpoint   text not null,
  sub        jsonb not null,               -- vollständiges PushSubscription-JSON
  updated_at timestamptz not null default now(),
  primary key (user_id, endpoint)
);

-- Opt-in-Zusatzfelder pro Gerät (Server-Cron liest sie mit Service-Role-Key):
--   morning   = Tages-Briefing morgens         (Function push-send / morning-Cron)
--   warn*     = amtliche Unwetter-Warnung (DWD) (Function weather-push)
alter table public.push_subscriptions add column if not exists morning   boolean default false;
alter table public.push_subscriptions add column if not exists warn      boolean default false;
alter table public.push_subscriptions add column if not exists warn_lat  double precision;
alter table public.push_subscriptions add column if not exists warn_lon  double precision;
alter table public.push_subscriptions add column if not exists warn_last text;

-- ------------------------------------------------------------
-- Endpoint muss zu einem bekannten Push-Dienst gehoeren
-- ------------------------------------------------------------
-- Die RLS-Policy unten erlaubt jedem Nutzer, in SEINER Zeile ein beliebiges
-- sub-JSONB abzulegen, endpoint eingeschlossen. push-send und die vier
-- Cron-Functions schicken danach mit dem Service-Role-Key ein HTTP-POST an
-- genau diese Adresse -- aus dem Supabase-Netz heraus. Damit liess sich die
-- Plattform als Ping-Werkzeug fuer interne Adressen missbrauchen
-- (blinde SSRF, z. B. http://169.254.169.254/). Die Pruefung gehoert in die
-- Tabelle und nicht in die Functions: alle fuenf lesen dieselbe Spalte, eine
-- sechste kaeme sonst wieder ohne Pruefung dazu.
--
-- Der abschliessende Schraegstrich im Muster ist tragend: ohne ihn passierten
-- https://fcm.googleapis.com@angreifer.tld/ und
-- https://fcm.googleapis.com.angreifer.tld/ die Pruefung.
do $$
begin
  alter table public.push_subscriptions
    add constraint push_endpoint_known check (
      endpoint ~ '^https://([a-z0-9-]+\.)*(googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)/'
      and endpoint !~ '[[:space:][:cntrl:]]'
      and length(endpoint) between 30 and 700
    ) not valid;
exception when duplicate_object then null;   -- schon vorhanden
end $$;

-- Zweite Haelfte derselben Luecke: geprueft wird oben die Spalte `endpoint`,
-- gesendet wird aber an `sub->>'endpoint'`. Ohne erzwungene Gleichheit traegt
-- der Angreifer in die Spalte eine gueltige Adresse ein und ins JSONB die
-- interne. Nebeneffekt derselben Ungleichheit: die Aufraeumlogik der Functions
-- (delete ... eq('endpoint', ...)) traefe die falsche Zeile.
-- coalesce() ist noetig, weil ein CHECK bei NULL als ERFUELLT gilt -- ein
-- fehlendes keys-Objekt haette die Pruefung sonst einfach uebersprungen.
do $$
begin
  alter table public.push_subscriptions
    add constraint push_sub_matches_endpoint check (
      jsonb_typeof(sub) = 'object'
      and (sub ->> 'endpoint') is not distinct from endpoint
      and jsonb_typeof(sub -> 'keys') = 'object'
      and coalesce(length(sub #>> '{keys,p256dh}'), 0) between 20 and 200
      and coalesce(length(sub #>> '{keys,auth}'), 0) between 10 and 100
    ) not valid;
exception when duplicate_object then null;
end $$;

-- NOT VALID heisst: neue und geaenderte Zeilen werden geprueft, bestehende
-- nicht. Das ist Absicht -- ein hartes ADD CONSTRAINT scheitert auf der
-- Produktions-DB an einer einzigen Altzeile, und dann liefe diese Datei gar
-- nicht mehr durch. Der folgende Block holt die Nachpruefung nach und meldet,
-- was im Weg steht, statt den Lauf abzubrechen.
do $$
declare v_bad int;
begin
  begin
    alter table public.push_subscriptions validate constraint push_endpoint_known;
    alter table public.push_subscriptions validate constraint push_sub_matches_endpoint;
  exception when check_violation then
    select count(*) into v_bad from public.push_subscriptions
     where endpoint !~ '^https://([a-z0-9-]+\.)*(googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)/'
        or (sub ->> 'endpoint') is distinct from endpoint;
    raise warning 'push_subscriptions: % Altzeile(n) mit unbekanntem oder abweichendem Endpoint. NEUE Zeilen sind bereits gesperrt. Bitte ansehen und loeschen, danach diese Datei erneut ausfuehren: select user_id, endpoint from public.push_subscriptions where endpoint !~ ''^https://([a-z0-9-]+\.)*(googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)/'';', v_bad;
  end;
end $$;

alter table public.push_subscriptions enable row level security;

-- ------------------------------------------------------------
-- Rechte und Policies
-- ------------------------------------------------------------
-- Bisher stand hier EINE Policy `for all` ohne Rollenangabe. Ohne `to` gilt sie
-- fuer PUBLIC, also auch fuer `anon` -- und `anon` hat ueber die Supabase-
-- Standardrechte Tabellenrechte auf allem in `public`. Eine Anfrage OHNE
-- gueltiges JWT kam damit bis zur Policy durch, wo auth.uid() NULL ist, und
-- scheiterte an der RLS-Bedingung. Im Log liest sich das als
-- „new row violates row-level security policy" -- ein Satz, der nach einem
-- Policy-Fehler klingt, obwohl in Wahrheit schlicht die Anmeldung fehlte.
-- (PostgREST macht daraus 401 statt 403, genau weil kein JWT dabei war; das
-- ist der verlaessliche Unterschied zwischen „nicht angemeldet" und „angemeldet,
-- aber fremde Zeile".)
-- Deshalb jetzt: `anon` hat hier gar nichts zu suchen, und die Policies nennen
-- ihre Rolle und ihr Kommando ausdruecklich.
-- Kinder sind davon NICHT betroffen: eine anonyme Supabase-Anmeldung hat
-- ebenfalls die Rolle `authenticated` (nur mit is_anonymous = true).
revoke all on public.push_subscriptions from anon;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- Nutzer verwalten ausschließlich ihre eigenen Abos.
-- (Die Edge Function push-send liest fremde Abos über den Service-Role-Key = RLS umgangen.)
-- Der Client schreibt per Upsert (on conflict user_id,endpoint); Postgres prueft
-- dabei die INSERT-Policy und im Konfliktfall zusaetzlich USING und WITH CHECK
-- der UPDATE-Policy. Alle drei muessen daher vorhanden sein.
drop policy if exists "push own subs"    on public.push_subscriptions;
drop policy if exists "push select own"  on public.push_subscriptions;
drop policy if exists "push insert own"  on public.push_subscriptions;
drop policy if exists "push update own"  on public.push_subscriptions;
drop policy if exists "push delete own"  on public.push_subscriptions;
create policy "push select own" on public.push_subscriptions
  for select to authenticated using (auth.uid() = user_id);
create policy "push insert own" on public.push_subscriptions
  for insert to authenticated with check (auth.uid() = user_id);
create policy "push update own" on public.push_subscriptions
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "push delete own" on public.push_subscriptions
  for delete to authenticated using (auth.uid() = user_id);

notify pgrst, 'reload schema';
