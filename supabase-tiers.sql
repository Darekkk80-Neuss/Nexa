-- ============================================================
-- Effyra – Phase 2: Stufen (Free/Medium/Premium) + KI-Kontingent + Stripe
-- Im Supabase SQL-Editor komplett ausführen ("Run"). Mehrfach ausführbar.
-- Voraussetzung: supabase-setup.sql wurde bereits ausgeführt (profiles-Tabelle).
-- ============================================================

-- ------------------------------------------------------------
-- 1) Neue Spalten auf profiles
--    tier      : free | medium | premium (Stufe)
--    ai_used   : verbrauchte KI-Abfragen im laufenden Monat
--    ai_extra  : nachbestelltes Zusatzkontingent im laufenden Monat
--    usage_month        : 'YYYY-MM' – Grundlage für den Monats-Reset
--    premium_until      : Ablauf des Premium-Abos (bei Kündigung -> läuft aus)
--    stripe_customer_id : Stripe-Kunde (für Abo/Portal)
-- ------------------------------------------------------------
alter table public.profiles add column if not exists tier text not null default 'free';
alter table public.profiles add column if not exists ai_used int not null default 0;
alter table public.profiles add column if not exists ai_extra int not null default 0;
alter table public.profiles add column if not exists usage_month text;
alter table public.profiles add column if not exists premium_until timestamptz;
alter table public.profiles add column if not exists stripe_customer_id text;

-- tier auf gültige Werte begrenzen
do $$ begin
  alter table public.profiles add constraint profiles_tier_chk check (tier in ('free','medium','premium'));
exception when duplicate_object then null; end $$;

-- Bestehende Premium-Nutzer (aus Phase 1 / plan) auf tier='premium' heben
update public.profiles set tier = 'premium' where plan = 'premium' and tier <> 'premium';

-- Nutzer dürfen tier/Kontingent NICHT selbst ändern (nur name, wie gehabt)
-- (die bestehenden GRANTS aus supabase-setup.sql erlauben nur update(name))

-- Basis-Monatslimit für Premium
create or replace function public.ai_base_limit() returns int
  language sql immutable as $$ select 500 $$;

-- ------------------------------------------------------------
-- 2) get_entitlements(): aktuellen Stand holen (mit Monats-Reset & Abo-Ablauf)
--    Vom angemeldeten Nutzer aufrufbar; liefert JSON.
-- ------------------------------------------------------------
create or replace function public.get_entitlements()
returns json
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  p public.profiles%rowtype;
  cur_month text := to_char(now(), 'YYYY-MM');
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select * into p from public.profiles where id = uid;
  if not found then raise exception 'no profile'; end if;

  -- Monatswechsel -> NUR das Monatskontingent zurücksetzen.
  -- ai_extra (gekaufte Credits) bleibt: es rollt über und verfällt nicht –
  -- so, wie es consume_ai durchgängig behandelt und die Paywall es zusagt.
  if p.usage_month is distinct from cur_month then
    update public.profiles
       set usage_month = cur_month, ai_used = 0
     where id = uid
     returning * into p;
  end if;

  -- Premium-Abo abgelaufen -> zurück auf Medium (App bleibt, KI weg)
  if p.tier = 'premium' and p.premium_until is not null and p.premium_until < now() then
    update public.profiles set tier = 'medium' where id = uid returning * into p;
  end if;

  return json_build_object(
    'tier',         p.tier,
    'ai_used',      p.ai_used,
    'ai_limit',     public.ai_base_limit() + coalesce(p.ai_extra, 0),
    'usage_month',  cur_month,
    'premium_until', p.premium_until
  );
end;
$$;

revoke execute on function public.get_entitlements() from public, anon;
grant  execute on function public.get_entitlements() to authenticated;

-- ------------------------------------------------------------
-- 3) consume_ai(user, n) — HIER ENTFERNT (bewusst).
--    ⚠️ Diese Datei definierte früher eine Premium-only-Version ohne Testphase.
--    Die EINE gültige, zusammengeführte Definition (Trial + eigenes Premium +
--    Familien-Pool) steht jetzt in **supabase-trial-and-play.sql** (Abschnitt 2)
--    und muss als LETZTE Datei ausgeführt werden. `consume_ai` wird hier nicht
--    mehr angelegt, damit ein erneuter Lauf die korrekte Version nicht überschreibt.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 4) apply_purchase(user, kind): nach erfolgreicher Stripe-Zahlung.
--    NUR vom Stripe-Webhook (service_role) aufrufbar.
--    kind: 'medium' (einmalig) | 'premium' (Abo, +32 Tage) | 'topup' (+500)
-- ------------------------------------------------------------
create or replace function public.apply_purchase(p_user uuid, p_kind text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare cur_month text := to_char(now(), 'YYYY-MM');
begin
  if p_kind = 'medium' then
    update public.profiles
       set tier = case when tier = 'premium' then 'premium' else 'medium' end
     where id = p_user;

  elsif p_kind = 'premium' then
    update public.profiles
       set tier = 'premium', plan = 'premium', premium_since = coalesce(premium_since, now()),
           premium_until = greatest(coalesce(premium_until, now()), now()) + interval '32 days',
           usage_month = cur_month
     where id = p_user;

  elsif p_kind = 'topup' then
    update public.profiles
       set ai_extra = coalesce(ai_extra, 0) + 500,
           usage_month = coalesce(usage_month, cur_month)
     where id = p_user;
  end if;
end;
$$;

revoke execute on function public.apply_purchase(uuid, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 5) set_stripe_customer(user, customer_id): vom Checkout gesetzt (service_role)
-- ------------------------------------------------------------
create or replace function public.set_stripe_customer(p_user uuid, p_customer text)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  update public.profiles set stripe_customer_id = p_customer where id = p_user;
end;
$$;
revoke execute on function public.set_stripe_customer(uuid, text) from public, anon, authenticated;

-- Der Code-Einlöser aus supabase-setup.sql setzt weiterhin plan='premium';
-- damit tier mitzieht, hier eine ergänzende Version:
create or replace function public.redeem_code(p_code text)
returns text
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  v_hash  text;
  v_found public.premium_codes%rowtype;
begin
  if auth.uid() is null then return 'not_authenticated'; end if;
  v_hash := encode(extensions.digest(upper(trim(p_code)), 'sha256'), 'hex');
  select * into v_found from public.premium_codes where code_hash = v_hash;
  if not found then return 'invalid'; end if;
  if v_found.used_by is not null and v_found.used_by <> auth.uid() then return 'already_used'; end if;

  update public.premium_codes set used_by = auth.uid(), used_at = now() where code_hash = v_hash;
  update public.profiles
     set plan = 'premium', tier = 'premium', premium_since = coalesce(premium_since, now()),
         premium_until = greatest(coalesce(premium_until, now()), now()) + interval '400 days'
   where id = auth.uid();
  return 'ok';
end;
$$;
revoke execute on function public.redeem_code(text) from public, anon;
grant  execute on function public.redeem_code(text) to authenticated;

-- PostgREST-Schema-Cache aktualisieren
notify pgrst, 'reload schema';

-- ============================================================
-- Fertig. Als Nächstes die Edge Functions deployen (siehe BACKEND.md, Phase 2).
-- ============================================================
