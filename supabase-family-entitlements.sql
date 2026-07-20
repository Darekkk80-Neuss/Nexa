-- ============================================================
-- Effyra – Familienabo: Berechtigung an ALLE verbundenen Mitglieder vererben
-- Im Supabase SQL-Editor komplett ausführen ("Run"). Mehrfach ausführbar (idempotent).
-- Voraussetzungen: supabase-setup.sql, supabase-tiers.sql und supabase-family.sql
-- wurden bereits ausgeführt (profiles, families, family_members, get_entitlements, consume_ai).
--
-- PROBLEM, das hier gelöst wird:
--   Bisher gilt das Abo pro Konto (profiles.tier). Der 6-stellige Familiencode verbindet
--   nur die DATEN – ein Family-Abo von Mitglied 1 schaltet Mitglied 2 NICHT frei.
-- LÖSUNG:
--   Der Familien-„Plan" wird auf der families-Zeile geführt (families.plan='family').
--   effective_tier(user) liefert Premium, wenn der Nutzer eigenes Premium hat ODER
--   zu einer Familie mit aktivem Family-Abo gehört (im Rahmen der Erwachsenen-Sitzplätze).
--   get_entitlements() und consume_ai() nutzen ab jetzt effective_tier() – die App
--   übernimmt das Ergebnis automatisch (syncEntitlements liest die 'tier').
--   KI-KONTINGENT: ein GEMEINSAMER Familien-Zähler (families.ai_used) statt 500 je Kopf.
--   Limit = 1600 Basis + 500 je ZUSAETZLICHEM Erwachsenen (Add-on) (+ Nachbestellung) – ein gemeinsamer Topf.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Family-Abo-Felder auf der families-Zeile
--    plan           : 'free' | 'family'   (Zustand des Familienabos)
--    plan_until     : Ablauf des Family-Abos (bei Kündigung -> läuft aus)
--    plan_by        : zahlendes Mitglied (immer abgedeckt)
--    seats_adults   : enthaltene Erwachsenen-Logins (Standard 2, +1 je Add-on)
--    seats_children : enthaltene Kinderplätze (Standard 3; Kinder haben kein eigenes
--                     Login -> informativ / für Phase 2, serverseitig nicht erzwungen)
-- ------------------------------------------------------------
alter table public.families add column if not exists plan           text not null default 'free';
alter table public.families add column if not exists plan_until     timestamptz;
alter table public.families add column if not exists plan_by        uuid references auth.users(id) on delete set null;
alter table public.families add column if not exists seats_adults   int not null default 2;
alter table public.families add column if not exists seats_children int not null default 3;

-- Gemeinsamer Familien-KI-Zähler: EIN Topf für alle Erwachsenen (statt 500 je Kopf).
--   ai_used  : im laufenden Monat verbrauchte Credits der GANZEN Familie
--   ai_extra : Familien-Nachbestellung im laufenden Monat
--   ai_month : 'YYYY-MM' – Grundlage für den Monats-Reset
alter table public.families add column if not exists ai_used  int not null default 0;
alter table public.families add column if not exists ai_extra int not null default 0;
alter table public.families add column if not exists ai_month text;

do $$ begin
  alter table public.families add constraint families_plan_chk check (plan in ('free','family'));
exception when duplicate_object then null; end $$;

-- Schnellerer Lookup „Familie eines Nutzers" (PK beginnt mit family_id, deckt user_id nicht ab)
create index if not exists family_members_user_idx on public.family_members(user_id);

-- ------------------------------------------------------------
-- 2) effective_tier(user): tatsächliche Stufe = max(eigene, geerbte Familie)
--    Interne Hilfsfunktion – nur von den SECURITY-DEFINER-Funktionen unten aufgerufen.
-- ------------------------------------------------------------
create or replace function public.effective_tier(p_user uuid)
returns text
language plpgsql
stable
security definer set search_path = public
as $$
declare
  v_tier       text;
  v_until      timestamptz;
  v_fid        uuid;
  v_plan       text;
  v_plan_until timestamptz;
  v_seats      int;
  v_plan_by    uuid;
  v_rank       int;
begin
  if p_user is null then return 'free'; end if;
  select tier, premium_until into v_tier, v_until from public.profiles where id = p_user;

  -- 1) Eigenes, aktives Premium schlägt alles
  if v_tier = 'premium' and (v_until is null or v_until >= now()) then
    return 'premium';
  end if;

  -- 2) Über die Familie geerbtes Family-Abo?
  select family_id into v_fid from public.family_members where user_id = p_user limit 1;
  if v_fid is not null then
    select plan, plan_until, coalesce(seats_adults, 2), plan_by
      into v_plan, v_plan_until, v_seats, v_plan_by
      from public.families where id = v_fid;

    if v_plan = 'family' and (v_plan_until is null or v_plan_until >= now()) then
      -- Der Zahler ist immer abgedeckt
      if p_user = v_plan_by then return 'premium'; end if;
      -- Sonst: gehört der Nutzer zu den ersten seats_adults Mitgliedern (nach Beitrittszeit)?
      -- (Kinder haben kein Login und stehen nicht in family_members -> hier zählen nur Erwachsene.)
      select count(*) into v_rank
        from public.family_members fm
       where fm.family_id = v_fid
         and fm.joined_at <= (select joined_at from public.family_members
                               where family_id = v_fid and user_id = p_user);
      if v_rank <= v_seats then return 'premium'; end if;
    end if;
  end if;

  -- 3) Fallback: eigene Stufe (abgelaufenes Premium -> medium)
  if v_tier = 'premium' then return 'medium'; end if;
  return coalesce(v_tier, 'free');
end;
$$;
revoke execute on function public.effective_tier(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3) get_entitlements() neu: liefert die EFFEKTIVE Stufe (inkl. Familie) + Herkunft.
--    Monats-Reset & Ablauf des EIGENEN Premiums bleiben wie gehabt.
-- ------------------------------------------------------------
create or replace function public.get_entitlements()
returns json
language plpgsql
security definer set search_path = public
as $$
declare
  uid       uuid := auth.uid();
  p         public.profiles%rowtype;
  cur_month text := to_char(now(), 'YYYY-MM');
  eff       text;
  v_via     boolean := false;
  v_fam_until timestamptz;
  fam_used  int; fam_extra int; fam_month text; fam_seats int; fam_seats_ch int;
  fam_limit int; via_fam_ai boolean := false;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select * into p from public.profiles where id = uid;
  if not found then raise exception 'no profile'; end if;

  -- Monatswechsel -> NUR das Monatskontingent zurücksetzen.
  -- ai_extra (gekaufte Credits) bleibt: es rollt über und verfällt nicht.
  if p.usage_month is distinct from cur_month then
    update public.profiles set usage_month = cur_month, ai_used = 0
      where id = uid returning * into p;
  end if;

  -- Eigenes Premium abgelaufen -> zurück auf Medium
  if p.tier = 'premium' and p.premium_until is not null and p.premium_until < now() then
    update public.profiles set tier = 'medium' where id = uid returning * into p;
  end if;

  eff := public.effective_tier(uid);

  -- Aktive Familie? -> gilt für den INHABER (plan_by) GENAUSO wie für geerbte Mitglieder.
  -- (Vorher nur für Mitglieder OHNE eigenes Premium – dadurch sah der Family-Käufer sich
  --  fälschlich als „Premium", weil apply_family_purchase ihn zusätzlich persönlich premium setzt.)
  select f.plan_until, f.ai_used, coalesce(f.ai_extra, 0), f.ai_month, coalesce(f.seats_adults, 2), coalesce(f.seats_children, 3)
    into v_fam_until, fam_used, fam_extra, fam_month, fam_seats, fam_seats_ch
    from public.family_members fm
    join public.families f on f.id = fm.family_id
   where fm.user_id = uid
     and f.plan = 'family'
     and (f.plan_until is null or f.plan_until >= now())
   limit 1;
  if fam_seats is not null then
    v_via := true;
    via_fam_ai := true;
    -- Monatswechsel: nur der Verbrauch startet neu; fam_extra (gekaufte Credits) bleibt stehen.
    if fam_month is distinct from cur_month then fam_used := 0; end if;
    -- Familien-Topf: Basis 1600 (enthaltene 2 Erwachsene) + 500 je ZUSAETZLICHEM Erwachsenen (Add-on) + Nachbestellung.
    fam_limit := 1600 + greatest(fam_seats - 2, 0) * 500 + coalesce(fam_extra, 0);
  end if;

  return json_build_object(
    'tier',            eff,
    'own_tier',        p.tier,
    'via_family',      v_via,
    'family_until',    v_fam_until,
    -- KI-Kontingent: bei Familien-Freischaltung der GEMEINSAME Topf, sonst das persönliche
    'ai_used',         case when via_fam_ai then fam_used  else p.ai_used end,
    'ai_limit',        case when via_fam_ai then fam_limit else public.ai_base_limit() + coalesce(p.ai_extra, 0) end,
    'ai_scope',        case when via_fam_ai then 'family'  else 'personal' end,
    'family_ai_used',  fam_used,
    'family_ai_limit', fam_limit,
    'seats_adults',    fam_seats,      -- zugebuchte Sitzplaetze -> Client spiegelt sie (geraeteuebergreifend)
    'seats_children',  fam_seats_ch,
    'usage_month',     cur_month,
    'premium_until',   p.premium_until
  );
end;
$$;
revoke execute on function public.get_entitlements() from public, anon;
grant  execute on function public.get_entitlements() to authenticated;

-- ------------------------------------------------------------
-- 4) consume_ai() — HIER ENTFERNT (bewusst).
--    ⚠️ Diese Datei definierte früher ein hartes Premium-Gate
--    (`if effective_tier <> 'premium' then return 'not_premium'`), das JEDEN
--    Free-/Trial-Nutzer mit 50 Credits sperrte. Da mehrere Dateien `consume_ai`
--    per `create or replace` neu anlegten, gewann „die zuletzt ausgeführte" –
--    was zu genau diesem Bug führte.
--    → Es gibt jetzt EINE zusammengeführte, gültige Definition (Trial + eigenes
--      Premium + Familien-Pool) in **supabase-trial-and-play.sql** (dort Abschnitt 2).
--    Diese Datei legt `consume_ai` NICHT mehr an, damit ein erneutes Ausführen die
--    korrekte Version nicht überschreiben kann. Reihenfolge: tiers → family-
--    entitlements → **trial-and-play (zuletzt)**.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 5) apply_family_purchase(user, days): nach erfolgreicher Family-Abo-Zahlung.
--    NUR vom Billing-Webhook (service_role) aufrufbar – z. B. Google Play RTDN / Stripe.
--    Setzt den Family-Plan auf die Familie des Käufers (legt bei Bedarf eine an),
--    der Käufer wird zusätzlich persönlich auf Premium gesetzt.
-- ------------------------------------------------------------
create or replace function public.apply_family_purchase(p_user uuid, p_days int default 32)
returns json
language plpgsql
security definer set search_path = public
as $$
declare v_fid uuid; v_code text; v_try int := 0;
begin
  select family_id into v_fid from public.family_members where user_id = p_user limit 1;

  -- Kein „Zuhause" für das Abo? -> Familie für den Käufer anlegen (wie create_family)
  if v_fid is null then
    loop
      v_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
      exit when not exists (select 1 from public.families where code = v_code);
      v_try := v_try + 1; if v_try > 20 then raise exception 'code generation failed'; end if;
    end loop;
    insert into public.families (code, created_by) values (v_code, p_user) returning id into v_fid;
    insert into public.family_members (family_id, user_id) values (v_fid, p_user) on conflict do nothing;
  end if;

  update public.families
     set plan       = 'family',
         plan_by    = p_user,
         plan_until = greatest(coalesce(plan_until, now()), now()) + make_interval(days => p_days)
   where id = v_fid;

  -- Käufer ist zahlender Nutzer -> persönlich ebenfalls Premium
  update public.profiles
     set tier          = 'premium',
         plan          = 'premium',
         premium_since = coalesce(premium_since, now()),
         premium_until = greatest(coalesce(premium_until, now()), now()) + make_interval(days => p_days),
         usage_month   = coalesce(usage_month, to_char(now(), 'YYYY-MM'))
   where id = p_user;

  return json_build_object('ok', true, 'family_id', v_fid,
    'plan_until', (select plan_until from public.families where id = v_fid));
end;
$$;
revoke execute on function public.apply_family_purchase(uuid, int) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 6) add_family_seat(user, kind): kostenpflichtiges Zusatz-Mitglied (service_role).
--    kind: 'adult' -> +1 Erwachsenen-Login (wirkt sofort auf die Sitzplatz-Deckelung)
--          'child' -> +1 Kinderplatz (informativ, siehe oben)
-- ------------------------------------------------------------
create or replace function public.add_family_seat(p_user uuid, p_kind text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare v_fid uuid;
begin
  select family_id into v_fid from public.family_members where user_id = p_user limit 1;
  if v_fid is null then raise exception 'no family'; end if;
  if p_kind = 'adult' then
    update public.families set seats_adults = seats_adults + 1 where id = v_fid;
  elsif p_kind = 'child' then
    update public.families set seats_children = seats_children + 1 where id = v_fid;
  end if;
end;
$$;
revoke execute on function public.add_family_seat(uuid, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 6b) add_family_ai(user, n): KI-Nachbestellung auf den GEMEINSAMEN Familien-Topf (service_role).
--     Erhöht families.ai_extra um n Credits im laufenden Monat.
-- ------------------------------------------------------------
create or replace function public.add_family_ai(p_user uuid, p_n int default 500)
returns void
language plpgsql
security definer set search_path = public
as $$
declare v_fid uuid; cur_month text := to_char(now(), 'YYYY-MM');
begin
  select family_id into v_fid from public.family_members where user_id = p_user limit 1;
  if v_fid is null then raise exception 'no family'; end if;
  -- ai_extra wird NUR erhöht: gekaufte Credits rollen über und verfallen nicht.
  -- Nur ai_used startet beim Monatswechsel neu.
  update public.families
     set ai_extra = coalesce(ai_extra, 0) + p_n,
         ai_used  = case when ai_month is distinct from cur_month then 0 else ai_used end,
         ai_month = cur_month
   where id = v_fid;
end;
$$;
revoke execute on function public.add_family_ai(uuid, int) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 7) cancel_family_plan(user): Family-Abo sofort beenden (service_role).
--    Für „zum Periodenende auslaufen lassen" einfach plan_until auf das Enddatum setzen
--    (statt now()). effective_tier prüft plan_until automatisch.
-- ------------------------------------------------------------
create or replace function public.cancel_family_plan(p_user uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare v_fid uuid;
begin
  select family_id into v_fid from public.family_members where user_id = p_user limit 1;
  if v_fid is null then return; end if;
  update public.families set plan_until = now() where id = v_fid and plan_by = p_user;
end;
$$;
revoke execute on function public.cancel_family_plan(uuid) from public, anon, authenticated;

-- PostgREST-Schema-Cache aktualisieren
notify pgrst, 'reload schema';

-- ============================================================
-- Fertig. Verkabelung, wenn das Billing live geht:
--   • Family-Abo gekauft  -> Webhook ruft  select public.apply_family_purchase(<user>, 32);
--   • Add-on Erwachsener   -> Webhook ruft  select public.add_family_seat(<user>, 'adult');
--   • Add-on Kind          -> Webhook ruft  select public.add_family_seat(<user>, 'child');
--   • KI-Nachbestellung Familie -> Webhook ruft select public.add_family_ai(<user>, 500);
--   • Abo gekündigt/abgelaufen -> Webhook ruft public.cancel_family_plan(<user>);
-- Danach übernimmt die App die Freischaltung automatisch (get_entitlements liefert 'tier').
-- KI: Familien-Mitglieder teilen sich EINEN Topf (families.ai_used), Limit = seats_adults × 500.
-- Zum scharf schalten der Paywall in der App: index.html  ENFORCE_TIERS = true.
-- ============================================================
