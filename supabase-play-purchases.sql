-- ============================================================
-- Effyra – Play-Abo-Lebenszyklus: Kauf↔Nutzer-Zuordnung + idempotente Ablauf-Sync
-- Für: (1) Re-Verifikation beim App-Start, (3) RTDN-Verlängerung/Storno.
-- Voraussetzung: profiles/families vorhanden (tiers/family-entitlements/trial-and-play).
-- Im Supabase SQL-Editor ausführen. Mehrfach ausführbar.
-- ============================================================

-- 1) Zuordnung purchaseToken → Nutzer (damit RTDN weiß, wen es betrifft).
create table if not exists public.play_purchases (
  purchase_token text primary key,
  user_id        uuid not null references auth.users(id) on delete cascade,
  sku            text not null,
  ptype          text not null default 'subs',
  expiry_ms      bigint,                    -- Googles expiryTimeMillis (für Add-on-Sitzplätze; >now = aktiv)
  updated_at     timestamptz not null default now()
);
alter table public.play_purchases add column if not exists expiry_ms bigint;
create index if not exists play_purchases_user_idx on public.play_purchases(user_id);
alter table public.play_purchases enable row level security;
revoke all on public.play_purchases from anon, authenticated;   -- nur service_role (Edge Functions)

-- 2) Ablaufdatum idempotent setzen (SET, NICHT verlängern → kein Runaway bei häufiger Re-Verifikation).
--    p_expiry_ms = Googles expiryTimeMillis. Liegt es in der Vergangenheit (Storno/Ablauf),
--    fällt der Zugang automatisch (effective_tier/get_entitlements stufen zurück).
create or replace function public.sync_play_expiry(p_user uuid, p_sku text, p_expiry_ms bigint)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_exp  timestamptz := to_timestamp(p_expiry_ms / 1000.0);
  v_fid  uuid;
  v_code text;
begin
  if p_sku = 'effyra_premium' then
    update public.profiles
       set tier = 'premium', plan = 'premium',
           premium_since = coalesce(premium_since, now()),
           premium_until = v_exp
     where id = p_user;
  elsif p_sku = 'effyra_family' then
    -- SELBSTHEILEND: Falls der Erstkauf-Grant (apply_family_purchase) nie ankam und
    -- daher noch KEINE Familie mit plan_by=Käufer existiert, hier eine anlegen –
    -- sonst würde der Sync den Käufer nur auf premium heben und Family bliebe „free".
    select fm.family_id into v_fid from public.family_members fm where fm.user_id = p_user limit 1;
    if v_fid is null then
      loop
        v_code := public.gen_family_code(8);   -- siehe supabase-codes.sql (CSPRNG, 31er-Alphabet)
        exit when not exists (select 1 from public.families where code = v_code);
      end loop;
      insert into public.families (code, created_by) values (v_code, p_user) returning id into v_fid;
      insert into public.family_members (family_id, user_id) values (v_fid, p_user) on conflict do nothing;
    end if;
    -- Familien-Abo IDEMPOTENT auf Googles echtes Ablaufdatum setzen (SET, keine kumulative Verlängerung)
    -- NUR schreiben, wenn die Familie keinen Zahler hat oder es derselbe ist.
    -- Vorher kippte ein beitretendes Mitglied mit einem alten Token das laufende
    -- Abo der ganzen Familie auf sein eigenes (moeglicherweise abgelaufenes)
    -- Datum – alle verloren den Zugang.
    update public.families set plan = 'family', plan_by = p_user, plan_until = v_exp
     where id = v_fid and (plan_by is null or plan_by = p_user);
    -- … und den Käufer persönlich ebenfalls (er ist selbst Premium).
    update public.profiles
       set tier = 'premium', plan = 'premium',
           premium_since = coalesce(premium_since, now()),
           premium_until = v_exp
     where id = p_user;
  end if;
  return json_build_object('ok', true, 'sku', p_sku, 'until', v_exp);
end $$;
revoke execute on function public.sync_play_expiry(uuid, text, bigint) from public, anon, authenticated;

-- 3) Familien-Sitzplätze IDEMPOTENT aus den aktiven Add-on-Abos neu berechnen.
--    seats_adults   = 2 (Basis) + Anzahl aktiver Erwachsenen-Add-ons in der Familie
--    seats_children = 3 (Basis) + Anzahl aktiver Kinder-Add-ons
--    „aktiv" = expiry_ms in der Zukunft. So gibt es kein Hochzählen bei Re-Verifikation/RTDN.
-- Variante nach FAMILIE statt nach Nutzer. Wird von leave_family gebraucht:
-- dort ist der Austretende schon aus family_members entfernt, die alte Familie
-- also über ihn nicht mehr auffindbar – ohne diese Funktion behielte sie die
-- Sitzplätze eines Add-ons, das mit dem Käufer längst weitergezogen ist.
create or replace function public.recompute_family_seats_fid(p_fid uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare v_ad int; v_ch int; v_now bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  if p_fid is null then return json_build_object('ok', false, 'reason', 'no_family'); end if;
  select count(*) filter (where pp.sku = 'effyra_adult'),
         count(*) filter (where pp.sku = 'effyra_child')
    into v_ad, v_ch
    from public.play_purchases pp
    join public.family_members fm on fm.user_id = pp.user_id
   where fm.family_id = p_fid
     and coalesce(pp.expiry_ms, 0) > v_now;
  update public.families
     set seats_adults   = 2 + coalesce(v_ad, 0),
         seats_children = 3 + coalesce(v_ch, 0)
   where id = p_fid;
  return json_build_object('ok', true, 'seats_adults', 2 + coalesce(v_ad, 0), 'seats_children', 3 + coalesce(v_ch, 0));
end $$;
revoke execute on function public.recompute_family_seats_fid(uuid) from public, anon, authenticated;

create or replace function public.recompute_family_seats(p_user uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare v_fid uuid; v_ad int; v_ch int; v_now bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  select family_id into v_fid from public.family_members where user_id = p_user limit 1;
  if v_fid is null then return json_build_object('ok', false, 'reason', 'no_family'); end if;
  select count(*) filter (where pp.sku = 'effyra_adult'),
         count(*) filter (where pp.sku = 'effyra_child')
    into v_ad, v_ch
    from public.play_purchases pp
    join public.family_members fm on fm.user_id = pp.user_id
   where fm.family_id = v_fid
     and coalesce(pp.expiry_ms, 0) > v_now;
  update public.families
     set seats_adults   = 2 + coalesce(v_ad, 0),
         seats_children = 3 + coalesce(v_ch, 0)
   where id = v_fid;
  return json_build_object('ok', true, 'seats_adults', 2 + coalesce(v_ad, 0), 'seats_children', 3 + coalesce(v_ch, 0));
end $$;
revoke execute on function public.recompute_family_seats(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- 4) Erstattung/Ruecklastschrift: Leistung wieder entziehen
-- ------------------------------------------------------------
-- Google meldet Erstattungen als voidedPurchaseNotification. Ohne diesen Weg
-- blieb die Leistung bestehen: kaufen, erstatten lassen, Credits behalten -
-- beliebig oft wiederholbar. Besonders teuer beim KI-Boost, weil gekaufte
-- Credits ueberrollen und nicht verfallen.
--
-- Bewusst ohne Negativ-Guthaben: verbrauchte Credits werden nicht
-- zurueckgefordert, nur der noch offene Rest entzogen. Alles andere waere
-- gegenueber Nutzern unfair, die in gutem Glauben verbraucht haben.
create or replace function public.revoke_play_purchase(p_user uuid, p_sku text)
returns json
language plpgsql security definer set search_path = public
as $$
declare v_fid uuid;
begin
  if p_sku = 'effyra_ai_boost' then
    -- Nur den noch vorhandenen Rest, nie unter null.
    select family_id into v_fid from public.family_members where user_id = p_user limit 1;
    if v_fid is not null and exists (select 1 from public.families where id = v_fid and plan = 'family') then
      update public.families set ai_extra = greatest(0, coalesce(ai_extra, 0) - 1000) where id = v_fid;
    else
      update public.profiles set ai_extra = greatest(0, coalesce(ai_extra, 0) - 1000) where id = p_user;
    end if;

  elsif p_sku = 'effyra_premium' then
    update public.profiles
       set premium_until = least(coalesce(premium_until, now()), now()), tier = 'medium'
     where id = p_user;

  elsif p_sku = 'effyra_family' then
    -- Nur die Familie treffen, deren Zahler die erstattende Person IST.
    update public.families
       set plan = 'free', plan_until = null, plan_by = null
     where plan_by = p_user;
    update public.profiles
       set premium_until = least(coalesce(premium_until, now()), now()), tier = 'medium'
     where id = p_user;

  elsif p_sku in ('effyra_adult', 'effyra_child') then
    -- Sitzplaetze rechnet recompute aus den noch AKTIVEN Kaeufen neu; der
    -- erstattete Kauf steht zu diesem Zeitpunkt bereits auf expiry_ms = 0.
    perform public.recompute_family_seats(p_user);
  end if;

  return json_build_object('ok', true, 'sku', p_sku);
end $$;
revoke execute on function public.revoke_play_purchase(uuid, text) from public, anon, authenticated;

notify pgrst, 'reload schema';
