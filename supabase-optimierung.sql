-- ============================================================
-- Effyra – Skalierungs-Optimierungen
-- Einmalig im Supabase SQL-Editor ausführen ("Run").
-- Erwartetes Ergebnis: "Success. No rows returned"
-- Das Script ist idempotent und kann gefahrlos mehrfach laufen.
--
-- REIHENFOLGE: NACH supabase-family.sql und supabase-tiers.sql ausführen.
-- Es ändert keine bestehende Funktion, sondern ergänzt nur – alte Clients
-- laufen unverändert weiter.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Familie nur laden, wenn sie sich geändert hat
-- ------------------------------------------------------------
-- Der Client pollt die Familie im Hintergrund. get_family() liefert dabei
-- jedes Mal den KOMPLETTEN Blob zurück, auch wenn sich nichts geändert hat –
-- der mit Abstand größte Übertragungsposten im ganzen System.
--
-- get_family_since(p_since) gibt stattdessen nur {"unchanged": true} zurück,
-- solange updated_at nicht neuer ist als der Stand des Clients. Erst bei einer
-- echten Änderung kommen die Daten. Bewusst eine EIGENE Funktion statt eines
-- Default-Parameters auf get_family(): ein überladenes get_family() wäre für
-- parameterlose Aufrufe mehrdeutig und würde bestehende Clients brechen.
create or replace function public.get_family_since(p_since timestamptz)
returns json language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_code text; v_data jsonb; v_upd timestamptz;
begin
  v_id := public.my_family_id();
  if v_id is null then return null; end if;
  select code, updated_at into v_code, v_upd from public.families where id = v_id;
  if v_id is null or v_code is null then return null; end if;
  if p_since is not null and v_upd <= p_since then
    return json_build_object('unchanged', true, 'updated_at', v_upd);
  end if;
  select data into v_data from public.families where id = v_id;
  return json_build_object('code', v_code, 'data', v_data, 'updated_at', v_upd);
end; $$;

revoke execute on function public.get_family_since(timestamptz) from public, anon;
grant  execute on function public.get_family_since(timestamptz) to authenticated;

-- ------------------------------------------------------------
-- 2) Rate-Limit für Operationen ohne Credit-Abzug
-- ------------------------------------------------------------
-- op='tts_greeting' läuft in claude-proxy bewusst auf Betreiber-Kosten und
-- verbraucht deshalb KEINE Credits. Damit fehlte ihm jede Bremse: ein Skript
-- mit gültigem Login konnte beliebig oft Sprachsynthese auslösen.
create table if not exists public.op_rate (
  user_id uuid not null references auth.users(id) on delete cascade,
  op      text not null,
  day     date not null default (now() at time zone 'utc')::date,
  n       int  not null default 0,
  primary key (user_id, op, day)
);
alter table public.op_rate enable row level security;
revoke all on public.op_rate from anon, authenticated;

-- Zählt einen Versuch und meldet, ob er noch im Tageskontingent liegt.
-- Atomar über INSERT ... ON CONFLICT DO UPDATE RETURNING – kein Read-Modify-Write.
create or replace function public.rate_take(p_user uuid, p_op text, p_max int)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  insert into public.op_rate as r (user_id, op, day, n)
  values (p_user, p_op, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, op, day) do update set n = r.n + 1
  returning r.n into v_n;
  return v_n <= p_max;
end; $$;

revoke execute on function public.rate_take(uuid, text, int) from public, anon, authenticated;

-- Alte Zähler aufräumen (Aufruf z. B. aus einem bestehenden Cron-Job).
create or replace function public.rate_prune()
returns void language sql security definer set search_path = public as $$
  delete from public.op_rate where day < (now() at time zone 'utc')::date - 7;
$$;
revoke execute on function public.rate_prune() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3) Cache für die gesprochene Start-Begrüßung
-- ------------------------------------------------------------
-- Die Begrüßung ("Guten Morgen, <Name>") wird bei jedem Kaltstart neu
-- synthetisiert, obwohl sie sich je Nutzer täglich wortgleich wiederholt – und
-- sie läuft ohne Credit-Abzug auf Betreiber-Kosten. Bei 20.000 Nutzern sind das
-- rund 20 Mio. Zeichen im Monat; gecacht bleiben davon einige Zehntausend.
-- Nutzer mit gleichem Vornamen und gleicher Sprache teilen sich einen Eintrag.
create table if not exists public.tts_cache (
  key        text primary key,           -- sha256(version|lang|voice|text)
  audio      text not null,              -- base64, wie es der Client erwartet
  mime       text not null default 'audio/mpeg',
  engine     text,                       -- google | elevenlabs | openai (nur zur Diagnose)
  created_at timestamptz not null default now(),
  last_used  timestamptz not null default now()
);
alter table public.tts_cache enable row level security;
revoke all on public.tts_cache from anon, authenticated;
create index if not exists tts_cache_last_used_idx on public.tts_cache (last_used);

-- Länger ungenutzte Einträge entfernen (z. B. monatlich per pg_cron).
-- Ohne das wüchse die Tabelle mit jedem je registrierten Vornamen weiter.
create or replace function public.tts_cache_prune()
returns int language sql security definer set search_path = public as $$
  with weg as (delete from public.tts_cache where last_used < now() - interval '60 days' returning 1)
  select count(*)::int from weg;
$$;
revoke execute on function public.tts_cache_prune() from public, anon, authenticated;

-- ------------------------------------------------------------
-- Rezept-Übersetzungen („Gericht des Tages")
-- ------------------------------------------------------------
-- Die Zubereitung ist Fließtext und lässt sich nicht über die eingebaute
-- Wortliste übersetzen (anders als Titel und Zutaten). Vorher lief das über die
-- KI DES NUTZERS (2 Credits je Rezept) und hing an KI-Einwilligung + Guthaben –
-- wer beides nicht hatte, sah die Zubereitung dauerhaft auf Englisch.
--
-- Jetzt übersetzt die Edge Function `meal-translate` serverseitig und legt das
-- Ergebnis hier ab: einmal je Rezept+Sprache, danach für ALLE Nutzer sofort und
-- kostenlos. TheMealDB hat einen endlichen Rezeptbestand, die Tabelle bleibt
-- also klein (Rezepte × 5 Sprachen).
create table if not exists public.meal_tr_cache (
  meal_id    text not null,               -- TheMealDB idMeal
  lang       text not null,               -- de | fr | es | it | pl  ('en' = Original, wird nie gespeichert)
  title      text,
  names      jsonb,                       -- Zutatennamen in der Reihenfolge des Originals
  instr      text,
  updated_at timestamptz not null default now(),
  primary key (meal_id, lang)
);
alter table public.meal_tr_cache enable row level security;
revoke all on public.meal_tr_cache from anon, authenticated;   -- nur service_role (Edge Function)

-- ------------------------------------------------------------
-- 4) Credit-Erstattung bei fehlgeschlagenen KI-Aufrufen
-- ------------------------------------------------------------
-- consume_ai bucht ab, BEVOR OpenAI gefragt wird. Schlägt der Aufruf fehl –
-- Zeitüberschreitung, Modell abgeschaltet, erreichtes Ausgabenlimit – war das
-- Credit bisher verloren. Bei op='invoice' sind das 10 Credits für nichts, und
-- bei einer Störung trifft es alle Nutzer gleichzeitig.
--
-- consume_ai belastet ERST den Monatstopf (ai_used), DANN gekaufte Credits
-- (ai_extra, die überrollen und nicht verfallen) – und liefert die Aufteilung als
-- from_month/from_extra zurück. Genau diese Aufteilung wird hier zurückgegeben.
--
-- Ohne die Aufteilung ginge es NICHT: eine Erstattung „erst ai_used" würde
-- gekaufte Credits in verfallende Monats-Credits verwandeln, eine Erstattung
-- „erst ai_extra" würde Monats-Credits in dauerhafte verwandeln. Beide Richtungen
-- sind falsch, nur je zulasten einer anderen Seite.
drop function if exists public.refund_ai(uuid, int, text);

create or replace function public.refund_ai(p_user uuid, p_month int, p_extra int, p_scope text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  cur_month text := to_char(now(), 'YYYY-MM');
  v_fid  uuid;
  f_used int; f_extra int; f_month text;
  p      public.profiles%rowtype;
  m int := greatest(0, coalesce(p_month, 0));   -- aus dem Monatstopf entnommen
  x int := greatest(0, coalesce(p_extra, 0));   -- aus gekauften Credits entnommen
begin
  if m + x <= 0 then return false; end if;

  -- Familientopf (consume_ai meldet scope='family')
  if p_scope = 'family' then
    select family_id into v_fid from public.family_members where user_id = p_user limit 1;
    if v_fid is null then return false; end if;
    select ai_used, coalesce(ai_extra, 0), ai_month into f_used, f_extra, f_month
      from public.families where id = v_fid for update;
    if not found then return false; end if;
    f_used := coalesce(f_used, 0);
    if f_month is distinct from cur_month then
      -- Monatswechsel zwischen Abbuchung und Erstattung: der Monatstopf ist
      -- ohnehin schon zurückgesetzt, dieser Anteil ist gegenstandslos. Nur die
      -- gekauften Credits zurückgeben – sonst liesse sich über den Monatswechsel
      -- dauerhaftes Guthaben erzeugen.
      update public.families set ai_extra = f_extra + x where id = v_fid;
    else
      update public.families
         set ai_used = greatest(0, f_used - m), ai_extra = f_extra + x
       where id = v_fid;
    end if;
    return true;
  end if;

  -- Persönlicher Topf (Premium, Testphase und gekaufte Credits)
  select * into p from public.profiles where id = p_user for update;
  if not found then return false; end if;
  if p.usage_month is distinct from cur_month then
    update public.profiles set ai_extra = coalesce(p.ai_extra, 0) + x where id = p_user;
  else
    update public.profiles
       set ai_used  = greatest(0, coalesce(p.ai_used, 0) - m),
           ai_extra = coalesce(p.ai_extra, 0) + x
     where id = p_user;
  end if;
  return true;
end; $$;

revoke execute on function public.refund_ai(uuid, int, int, text) from public, anon, authenticated;

-- Übergangs-Hülle mit der ALTEN 3-Argument-Signatur.
-- Ohne sie gäbe es kein sicheres Deployment-Fenster: wird dieses SQL vor der
-- neuen claude-proxy eingespielt, ruft die noch laufende alte Version weiter
-- refund_ai(p_user, p_n, p_scope) – und liefe in „function not found", ohne dass
-- es jemand merkt. PostgREST unterscheidet Überladungen an den PARAMETERNAMEN
-- (p_n gegenüber p_month/p_extra), es entsteht also keine Mehrdeutigkeit.
-- Kann entfernt werden, sobald die neue Function überall läuft.
create or replace function public.refund_ai(p_user uuid, p_n int, p_scope text default null)
returns boolean language sql security definer set search_path = public as $$
  select public.refund_ai(p_user, p_n, 0, p_scope);
$$;
revoke execute on function public.refund_ai(uuid, int, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 5) Nutzungs- und Kostenstatistik je Operation
-- ------------------------------------------------------------
-- OpenAI liefert in jeder Antwort ein usage-Objekt; bisher wurde es verworfen.
-- Ohne diese Zahlen bleibt die Frage „was kostet mich ein Credit wirklich"
-- eine Schätzung. Bewusst TAGESAGGREGAT ohne user_id: keine Personendaten,
-- keine Verhaltensprofile, trotzdem exakte Kosten je Operation.
create table if not exists public.ai_usage_daily (
  day               date not null default (now() at time zone 'utc')::date,
  op                text not null,
  model             text not null,
  calls             int    not null default 0,
  credits           int    not null default 0,
  prompt_tokens     bigint not null default 0,
  completion_tokens bigint not null default 0,
  reasoning_tokens  bigint not null default 0,   -- Teilmenge von completion_tokens
  cached_tokens     bigint not null default 0,   -- Teilmenge von prompt_tokens, günstiger abgerechnet
  failures          int    not null default 0,
  primary key (day, op, model)
);
-- In bestehenden Projekten steht die Tabelle bereits; create table if not exists
-- ergänzt dort KEINE Spalte, und ai_usage_track liefe beim nächsten Aufruf in
-- "column does not exist" – lautlos, weil claude-proxy Telemetriefehler
-- verschluckt (Promise.catch in track()).
alter table public.ai_usage_daily add column if not exists cached_tokens bigint not null default 0;
alter table public.ai_usage_daily enable row level security;
revoke all on public.ai_usage_daily from anon, authenticated;

-- Die alte 7-Argument-Fassung MUSS weg, bevor die neue entsteht: create or replace
-- ersetzt nur bei identischer Argumentliste, sonst stünden beide nebeneinander.
-- PostgREST könnte einen Aufruf mit den alten sieben Schlüsseln dann keiner von
-- beiden eindeutig zuordnen (der neue Parameter hat einen Default) und antwortete
-- mit PGRST203. Nach dem Drop löst genau dieser Aufruf – also die noch laufende
-- alte claude-proxy – sauber auf die neue Funktion auf; deshalb gibt es kein
-- Deployment-Fenster, in dem Zahlen verloren gehen.
drop function if exists public.ai_usage_track(text, text, int, bigint, bigint, bigint, boolean);

-- p_cached steht hinten, weil Postgres verlangt, dass Parameter mit Default nach
-- allen Parametern ohne Default stehen (p_ok hat keinen).
create or replace function public.ai_usage_track(
  p_op text, p_model text, p_credits int,
  p_in bigint, p_out bigint, p_reason bigint, p_ok boolean,
  p_cached bigint default 0)
returns void language sql security definer set search_path = public as $$
  insert into public.ai_usage_daily as u
    (day, op, model, calls, credits, prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens, failures)
  values ((now() at time zone 'utc')::date, coalesce(p_op, '?'), coalesce(p_model, '?'), 1,
          coalesce(p_credits, 0), coalesce(p_in, 0), coalesce(p_out, 0), coalesce(p_reason, 0),
          least(coalesce(p_cached, 0), coalesce(p_in, 0)),
          case when p_ok then 0 else 1 end)
  on conflict (day, op, model) do update set
    calls             = u.calls + 1,
    credits           = u.credits + coalesce(p_credits, 0),
    prompt_tokens     = u.prompt_tokens + coalesce(p_in, 0),
    completion_tokens = u.completion_tokens + coalesce(p_out, 0),
    reasoning_tokens  = u.reasoning_tokens + coalesce(p_reason, 0),
    -- least(...) deckelt den gecachten Anteil auf den gemeldeten Input. Meldet
    -- OpenAI die beiden Werte einmal inkonsistent, würde die Differenz in
    -- ai_kosten sonst negativ und die Kosten kleiner als null.
    cached_tokens     = u.cached_tokens + least(coalesce(p_cached, 0), coalesce(p_in, 0)),
    failures          = u.failures + case when p_ok then 0 else 1 end; $$;

revoke execute on function public.ai_usage_track(text, text, int, bigint, bigint, bigint, boolean, bigint)
  from public, anon, authenticated;

-- Auswertung: Kosten je Credit je Operation. Preise als Parameter, damit die
-- Abfrage bei Preisänderungen nicht angefasst werden muss.
--   select * from public.ai_kosten(0.75, 4.50, 0.075);   -- $/Mio. Token in/out/gecacht
--
-- Der dritte Preis ist NEU. Bisher ging der gesamte prompt_tokens-Wert zum vollen
-- Input-Preis in die Rechnung ein, obwohl OpenAI den gecachten Anteil erheblich
-- günstiger abrechnet – die ausgewiesenen Kosten je Credit lagen dadurch dauerhaft
-- zu hoch. Bewusst ein eigener Parameter und kein fester Faktor: das Verhältnis
-- ist modellabhängig (GPT-5-Reihe grob ein Zehntel des Input-Preises, gpt-4o-mini
-- grob die Hälfte – vor Gebrauch an der aktuellen OpenAI-Preisliste prüfen), und
-- ein verdrahteter Faktor wäre nach dem nächsten Wechsel von OPENAI_MODEL_CHAIN
-- wieder falsch, ohne dass es jemandem auffällt.
--
-- Zeilen mit 0 Tokens sind KEIN Fehler: Sprachausgabe, Transkription und der
-- Live-Modus werden nach Minuten bzw. Zeichen abgerechnet, nicht nach Tokens.
-- Für diese Operationen sind calls und failures aussagekräftig, kosten ist es
-- nicht – der Betrag steht dort nur in der Anbieterrechnung.

-- Zwei- und Drei-Parameter-Fassung dürfen nicht nebeneinander stehen, sonst ist
-- der bisherige Aufruf ai_kosten(0.75, 4.50) mehrdeutig.
drop function if exists public.ai_kosten(numeric, numeric);

create or replace function public.ai_kosten(p_in_preis numeric, p_out_preis numeric, p_cache_preis numeric default 0)
returns table (op text, calls bigint, credits bigint, fehler bigint, kosten numeric, kosten_je_credit numeric)
language sql security definer set search_path = public as $$
  with k as (
    select u.op,
           sum(u.calls)::bigint                                   as calls,
           sum(u.credits)::bigint                                 as credits,
           sum(u.failures)::bigint                                as fehler,
           (sum(u.prompt_tokens) - sum(u.cached_tokens)) / 1e6 * p_in_preis
         + sum(u.cached_tokens)     / 1e6 * coalesce(p_cache_preis, 0)
         + sum(u.completion_tokens) / 1e6 * p_out_preis           as kosten
      from public.ai_usage_daily u
     group by u.op
  )
  select k.op, k.calls, k.credits, k.fehler,
         round(k.kosten, 4),
         round(k.kosten / nullif(k.credits, 0), 6)
    from k
   order by k.kosten desc; $$;
-- Auch angemeldeten Nutzern entziehen: das sind Betriebszahlen, keine Nutzerdaten.
revoke execute on function public.ai_kosten(numeric, numeric, numeric) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 6) Fehlende Indizes
-- ------------------------------------------------------------
-- Die Cron-Jobs filtern auf morning/warn. Ohne Index ist das ein Seq Scan über
-- die gesamte Abo-Tabelle. Partiell, weil nur die true-Zeilen gesucht werden.
-- Beide Spalten werden erst nachträglich angelegt (siehe Kopf von weather-push
-- bzw. morning-push) – deshalb nur anlegen, wenn sie schon existieren.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'push_subscriptions' and column_name = 'morning') then
    create index if not exists push_subscriptions_morning_idx
      on public.push_subscriptions (user_id) where morning;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'push_subscriptions' and column_name = 'warn') then
    create index if not exists push_subscriptions_warn_idx
      on public.push_subscriptions (user_id) where warn;
  end if;
end $$;

-- Aufräumen toter Abos läuft jetzt gebündelt über endpoint statt (user_id, endpoint).
create index if not exists push_subscriptions_endpoint_idx
  on public.push_subscriptions (endpoint);

-- get_family_since vergleicht updated_at; Familien werden zudem danach sortiert gelesen.
create index if not exists families_updated_at_idx
  on public.families (updated_at);

create index if not exists op_rate_day_idx on public.op_rate (day);

notify pgrst, 'reload schema';
