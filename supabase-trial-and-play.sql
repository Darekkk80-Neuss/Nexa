-- ============================================================================
-- Effyra – Trial (50 Credits / 7 Tage) serverseitig + Google-Play-Entitlements
-- ----------------------------------------------------------------------------
-- Im Supabase SQL-Editor ausführen. MUSS als LETZTE der drei Tier-Dateien laufen
-- (Reihenfolge: tiers → family-entitlements → DIESE). Setzt voraus, dass
-- supabase-tiers.sql und supabase-family-entitlements.sql bereits gelaufen sind
-- (profiles, effective_tier, ai_base_limit, families, get_entitlements,
-- apply_family_purchase, grant_entitlement).
-- ⚠️ consume_ai wird AUSSCHLIESSLICH hier definiert (Abschnitt 2, zusammengeführt:
--    Trial + eigenes Premium + Familien-Pool). tiers.sql/family-entitlements.sql
--    legen es bewusst nicht mehr an, damit die korrekte Version nicht überschrieben wird.
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
create or replace function public.ai_trial_days()    returns int language sql immutable as $$ select 7 $$;
create or replace function public.ai_family_seat()   returns int language sql immutable as $$ select 500 $$;   -- DEPRECATED (nicht mehr genutzt): Familien-Limit = 1600 Basis + 500 je Zusatz-Erwachsener (siehe consume_ai / get_entitlements)

-- 2) consume_ai (ZUSAMMENGEFÜHRT — EINZIGE gültige Definition) --------------
--    Deckt ALLE Fälle in EINER Funktion ab, damit es keine „letzte-Datei-gewinnt"-
--    Falle mehr gibt (früher blockierten sich Trial- und Familien-Version gegenseitig):
--      • Premium (eigenes ODER über Familie geerbt) → 500/Monat je Sitz.
--          - über aktives Family-Abo abgedeckt → GEMEINSAMER Familien-Zähler (families)
--          - sonst → persönlicher Premium-Zähler (profiles)
--      • Free innerhalb der 7-Tage-Testphase → 50 Credits (+ nachgekaufte ai_extra)
--      • Free nach 7 Tagen → 'trial_over'   |   medium/abgelaufen → 'not_premium'
--    Stufe wird über effective_tier() bestimmt (kennt eigenes + geerbtes Premium).
--    NUR vom Claude-Proxy (service_role) aufrufbar.
create or replace function public.consume_ai(p_user uuid, p_n int default 1)
returns json
language plpgsql
security definer set search_path = public
as $$
declare
  p            public.profiles%rowtype;
  cur_month    text := to_char(now(), 'YYYY-MM');
  eff          text;
  v_fid        uuid;
  v_plan       text; v_plan_until timestamptz; v_seats int; v_plan_by uuid; v_rank int;
  via_family   boolean := false;
  f_used int; f_extra int; f_month text;
  in_trial     boolean;
  base int; avail int; from_month int;   -- base = Monats-Grundkontingent; avail = Rest des Monatstopfs
begin
  -- Verbrauchslogik überall gleich: ERST Monats-Kontingent (refresht monatlich),
  -- DANN gekaufte Credits (ai_extra) – diese ROLLEN ÜBER und verfallen NICHT.
  eff := public.effective_tier(p_user);   -- 'premium' | 'medium' | 'free' (inkl. Familie)

  -- ================= PREMIUM (eigenes ODER über Familie geerbt) =================
  if eff = 'premium' then
    select family_id into v_fid from public.family_members where user_id = p_user limit 1;
    if v_fid is not null then
      select plan, plan_until, coalesce(seats_adults, 2), plan_by
        into v_plan, v_plan_until, v_seats, v_plan_by
        from public.families where id = v_fid;
      if v_plan = 'family' and (v_plan_until is null or v_plan_until >= now()) then
        if p_user = v_plan_by then
          via_family := true;
        else
          select count(*) into v_rank from public.family_members fm
            where fm.family_id = v_fid
              and fm.joined_at <= (select joined_at from public.family_members
                                    where family_id = v_fid and user_id = p_user);
          if v_rank <= v_seats then via_family := true; end if;
        end if;
      end if;
    end if;

    -- Fall A: GEMEINSAMER Familien-Zähler. Monatstopf refresht; ai_extra bleibt (rollt über).
    if via_family then
      select ai_used, coalesce(ai_extra, 0), ai_month into f_used, f_extra, f_month
        from public.families where id = v_fid for update;
      if f_month is distinct from cur_month then f_used := 0; f_month := cur_month; end if;   -- f_extra bleibt!
      base  := 1600 + greatest(v_seats - 2, 0) * 500;   -- Familien-Topf: Basis 1600 (2 Erw.) + 500 je ZUSAETZLICHEM Erwachsenen
      avail := greatest(0, base - f_used);
      if avail + f_extra < p_n then
        update public.families set ai_used = f_used, ai_extra = f_extra, ai_month = cur_month where id = v_fid;
        return json_build_object('ok', false, 'reason', 'quota_exceeded', 'scope', 'family', 'ai_used', f_used, 'ai_limit', base + f_extra);
      end if;
      from_month := least(p_n, avail);
      f_used  := f_used + from_month;
      f_extra := f_extra - (p_n - from_month);
      update public.families set ai_used = f_used, ai_extra = f_extra, ai_month = cur_month where id = v_fid;
      -- from_month/from_extra: Aufteilung der Abbuchung. refund_ai kann sie sonst
      -- nicht rekonstruieren und wuerde gekaufte Credits in Monats-Credits verwandeln.
      return json_build_object('ok', true, 'scope', 'family', 'ai_used', f_used, 'ai_limit', base + f_extra,
                               'from_month', from_month, 'from_extra', p_n - from_month);
    end if;

    -- Fall B: persönlicher Premium-Zähler
    select * into p from public.profiles where id = p_user for update;
    if not found then return json_build_object('ok', false, 'reason', 'no_profile'); end if;
    if p.usage_month is distinct from cur_month then p.usage_month := cur_month; p.ai_used := 0; end if;   -- ai_extra bleibt!
    base  := public.ai_base_limit();
    avail := greatest(0, base - p.ai_used);
    if avail + coalesce(p.ai_extra, 0) < p_n then
      update public.profiles set usage_month = cur_month, ai_used = p.ai_used, ai_extra = coalesce(p.ai_extra, 0) where id = p_user;
      return json_build_object('ok', false, 'reason', 'quota_exceeded', 'scope', 'personal', 'ai_used', p.ai_used, 'ai_limit', base + coalesce(p.ai_extra, 0));
    end if;
    from_month := least(p_n, avail);
    p.ai_used  := p.ai_used + from_month;
    p.ai_extra := coalesce(p.ai_extra, 0) - (p_n - from_month);
    update public.profiles set usage_month = cur_month, ai_used = p.ai_used, ai_extra = p.ai_extra where id = p_user;
    return json_build_object('ok', true, 'scope', 'personal', 'ai_used', p.ai_used, 'ai_limit', base + p.ai_extra,
                             'from_month', from_month, 'from_extra', p_n - from_month);
  end if;

  -- ================= FREE-TESTPHASE (50 Credits / 7 Tage) + gekaufte Credits =================
  select * into p from public.profiles where id = p_user for update;
  if not found then return json_build_object('ok', false, 'reason', 'no_profile'); end if;
  if p.usage_month is distinct from cur_month then p.usage_month := cur_month; p.ai_used := 0; end if;   -- ai_extra bleibt!

  in_trial := (p.tier = 'free')
              and (now() < coalesce(p.trial_start, now()) + (public.ai_trial_days() || ' days')::interval);

  -- Monats-Grundkontingent nur in der Testphase; gekaufte Credits (ai_extra) gelten immer, solange Guthaben da ist.
  base  := (case when in_trial then public.ai_trial_credits() else 0 end);
  avail := greatest(0, base - p.ai_used);
  if avail + coalesce(p.ai_extra, 0) < p_n then
    update public.profiles set usage_month = cur_month, ai_used = p.ai_used, ai_extra = coalesce(p.ai_extra, 0) where id = p_user;
    return json_build_object('ok', false,
      'reason', case when in_trial then 'quota_exceeded' when p.tier = 'free' then 'trial_over' else 'not_premium' end,
      'ai_used', p.ai_used, 'ai_limit', base + coalesce(p.ai_extra, 0));
  end if;
  from_month := least(p_n, avail);
  p.ai_used  := p.ai_used + from_month;
  p.ai_extra := coalesce(p.ai_extra, 0) - (p_n - from_month);
  update public.profiles set usage_month = cur_month, ai_used = p.ai_used, ai_extra = p.ai_extra where id = p_user;
  return json_build_object('ok', true, 'scope', 'personal', 'ai_used', p.ai_used, 'ai_limit', base + p.ai_extra,
                           'from_month', from_month, 'from_extra', p_n - from_month);
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
declare v_res json; v_fid uuid;
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
    -- KI-Boost: +1000 Credits, die ÜBERROLLEN (kein Monats-Verfall).
    -- Landen im Topf, aus dem der Nutzer wirklich schöpft: aktives Family-Abo → Familien-Topf, sonst persönlich.
    select fm.family_id into v_fid
      from public.family_members fm join public.families f on f.id = fm.family_id
     where fm.user_id = p_user and f.plan = 'family' and (f.plan_until is null or f.plan_until >= now())
     limit 1;
    if v_fid is not null then
      -- WICHTIG: ai_month mitsetzen – sonst maskiert get_entitlements die +1000 in der Anzeige auf 0
      -- (Monats-Reset-Gate). Betrag rollt weiter über, es wird nur der Monatsstempel aktualisiert.
      update public.families
         set ai_extra = coalesce(ai_extra, 0) + 1000,
             ai_month = to_char(now(), 'YYYY-MM')
       where id = v_fid;
    else
      update public.profiles set ai_extra = coalesce(ai_extra, 0) + 1000 where id = p_user;
    end if;
    v_res := json_build_object('ok', true, 'kind', 'topup');
  else
    -- Add-ons (effyra_adult / effyra_child) → über die Family-Seat-Funktion
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
