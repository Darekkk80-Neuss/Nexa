-- ============================================================================
-- Effyra – Trial (50 Credits / 14 Tage) serverseitig + Google-Play-Entitlements
-- ----------------------------------------------------------------------------
-- Im Supabase SQL-Editor ausführen. Setzt voraus, dass supabase-tiers.sql und
-- supabase-family-entitlements.sql bereits gelaufen sind (profiles, consume_ai,
-- get_entitlements, apply_family_purchase, grant_entitlement).
--
-- ⚠️ WICHTIG vor dem Ausführen:
--   1) Deine aktuell aktive get_entitlements() steht in supabase-family-entitlements.sql
--      (v2 mit effective_tier). Diese Datei ÄNDERT get_entitlements NICHT, sondern nur
--      consume_ai (die eigentliche KI-Sperre). Optional-Snippet für get_entitlements
--      steht unten (Abschnitt 4) – nur einbauen, wenn du die Trial-Restanzeige serverseitig
--      spiegeln willst; sonst reicht die Client-Anzeige.
--   2) In einer Test-/Staging-DB gegenprüfen, bevor Produktion.
-- ============================================================================

-- 1) Trial-Start je Nutzer + Lifetime-Flag ----------------------------------
alter table public.profiles add column if not exists trial_start timestamptz not null default now();
alter table public.profiles add column if not exists lifetime boolean not null default false;
-- Bestehende Profile: Trial ab jetzt (bzw. ab Kontoerstellung, falls vorhanden)
update public.profiles set trial_start = coalesce(trial_start, now()) where trial_start is null;

create or replace function public.ai_trial_credits() returns int language sql immutable as $$ select 50 $$;
create or replace function public.ai_trial_days()    returns int language sql immutable as $$ select 14 $$;

-- 2) consume_ai NEU: Trial (Free) mit 50 Credits/14 Tagen serverseitig ------
--    Free  : bis 50 Credits innerhalb 14 Tagen → danach 'trial_over'
--    premium: 500/Monat (+ ai_extra)  |  medium/lifetime: kein Server-KI ('no_ai')
create or replace function public.consume_ai(p_user uuid, p_n int default 1)
returns json
language plpgsql
security definer set search_path = public
as $$
declare
  p public.profiles%rowtype;
  cur_month text := to_char(now(), 'YYYY-MM');
  lim int;
  is_prem boolean;
  in_trial boolean;
begin
  select * into p from public.profiles where id = p_user for update;
  if not found then return json_build_object('ok', false, 'reason', 'no_profile'); end if;

  -- Monatswechsel → Verbrauch/Nachbestellung zurücksetzen
  if p.usage_month is distinct from cur_month then
    p.usage_month := cur_month; p.ai_used := 0; p.ai_extra := 0;
  end if;

  is_prem  := (p.tier = 'premium') and (p.premium_until is null or p.premium_until >= now());
  in_trial := (not is_prem) and (p.tier = 'free')
              and (now() < coalesce(p.trial_start, now()) + (public.ai_trial_days() || ' days')::interval);

  -- Limit je Situation bestimmen
  if is_prem then
    lim := public.ai_base_limit() + coalesce(p.ai_extra, 0);          -- 500 (+extra)
  elsif in_trial then
    lim := public.ai_trial_credits() + coalesce(p.ai_extra, 0);       -- 50 (+nachgekaufte)
  else
    -- kein KI-Zugang (medium/lifetime, oder Free nach 14 Tagen)
    update public.profiles set usage_month = cur_month, ai_used = p.ai_used, ai_extra = p.ai_extra where id = p_user;
    return json_build_object('ok', false,
      'reason', case when p.tier = 'free' then 'trial_over' else 'not_premium' end,
      'ai_used', p.ai_used, 'ai_limit', 0);
  end if;

  if p.ai_used + p_n > lim then
    update public.profiles set usage_month = cur_month, ai_used = p.ai_used, ai_extra = p.ai_extra where id = p_user;
    return json_build_object('ok', false, 'reason', 'quota_exceeded', 'ai_used', p.ai_used, 'ai_limit', lim);
  end if;

  update public.profiles set usage_month = cur_month, ai_used = p.ai_used + p_n, ai_extra = p.ai_extra where id = p_user;
  return json_build_object('ok', true, 'ai_used', p.ai_used + p_n, 'ai_limit', lim);
end;
$$;
revoke execute on function public.consume_ai(uuid, int) from public, anon, authenticated;

-- 3) grant_play_purchase(user, sku): vom play-verify-Webhook (service_role) --
--    Mappt die Play-Produkt-ID auf das passende Entitlement.
create or replace function public.grant_play_purchase(p_user uuid, p_sku text)
returns json
language plpgsql
security definer set search_path = public
as $$
declare v_res json;
begin
  if p_sku = 'effyra_premium' then
    update public.profiles
       set tier = 'premium', plan = 'premium',
           premium_since = coalesce(premium_since, now()),
           premium_until = greatest(coalesce(premium_until, now()), now()) + interval '32 days'
     where id = p_user;
    v_res := json_build_object('ok', true, 'kind', 'premium');
  elsif p_sku = 'effyra_family' then
    v_res := public.apply_family_purchase(p_user, 32);               -- bestehende Family-Funktion
  elsif p_sku = 'effyra_lifetime' then
    update public.profiles set lifetime = true,
           tier = case when tier = 'premium' then 'premium' else 'medium' end
     where id = p_user;
    v_res := json_build_object('ok', true, 'kind', 'lifetime');
  elsif p_sku = 'effyra_ai_boost' then
    update public.profiles set ai_extra = coalesce(ai_extra, 0) + 500 where id = p_user;
    v_res := json_build_object('ok', true, 'kind', 'topup');
  else
    -- Add-ons (effyra_adult_addon / effyra_child_addon) → über die Family-Seat-Funktion
    v_res := json_build_object('ok', false, 'reason', 'sku_not_handled_here', 'sku', p_sku);
  end if;
  return v_res;
end;
$$;
revoke execute on function public.grant_play_purchase(uuid, text) from public, anon, authenticated;

-- 4) OPTIONAL – get_entitlements um Trial-Infos ergänzen ---------------------
--    Nur einbauen, wenn du die Trial-Restanzeige serverseitig (statt clientseitig)
--    führen willst. Dann in DEINER aktiven get_entitlements() (family-entitlements.sql)
--    das Rückgabe-JSON um diese Felder erweitern:
--      'trial_start',  p.trial_start,
--      'trial_days',   public.ai_trial_days(),
--      'ai_limit',     (case when <is_premium> then public.ai_base_limit()
--                            when <in_trial>   then public.ai_trial_credits()
--                            else 0 end) + coalesce(p.ai_extra,0)

notify pgrst, 'reload schema';
-- Fertig. Danach: play-verify deployen (ruft grant_play_purchase), Play-Produkte anlegen.
