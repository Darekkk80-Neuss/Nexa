-- ============================================================
-- Effyra – Datenexport Art. 20 DSGVO (serverseitiger Teil)
-- Im Supabase SQL-Editor ausführen. Mehrfach ausführbar.
-- Reihenfolge: als LETZTE Datei, nach 1–11 (siehe RUNBOOK.md).
-- Liest Spalten, die erst dort entstehen: profiles.tier/ai_used (tiers),
-- profiles.lifetime (trial-and-play), profiles.auth_provider (trial-schutz),
-- families.plan/plan_by (family-entitlements), play_purchases (play-purchases).
-- ============================================================

-- Warum überhaupt serverseitig: profiles und consents könnte der Client selbst
-- lesen, play_purchases, families und family_members aber NICHT – dort steht
-- `revoke all from anon, authenticated`. Ohne diese Funktion fehlten dem Export
-- genau die Daten, die der Nutzer nirgends sonst einsehen kann.
--
-- Art. 20 Abs. 4 DSGVO: der Export darf die Rechte anderer nicht
-- beeinträchtigen. families.data gehört allen Mitgliedern gemeinsam und wird
-- deshalb NIE roh ausgegeben, sondern gefiltert:
--   members  → nur der eigene Eintrag (authId = auth.uid())
--   tasks    → nur selbst angelegte (by) oder mir zugewiesene (assignee)
--   shopping → nur selbst angelegte (by)
--   occasions/events → gar nicht. Sie tragen kein Urheberfeld (anders als tasks
--   und shopping, die `by: famSelfId()` setzen) und lassen sich keiner Person
--   zuordnen. Ein "im Zweifel mitgeben" hätte fremde Geburtstage exportiert.
create or replace function public.export_my_data()
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_profile  json;
  v_consents json;
  v_push     json;
  v_play     json;
  v_family   json := null;
  v_fid      uuid;
  v_data     jsonb;
  v_me       jsonb;
  v_meid     text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select to_json(p) into v_profile
    from (select id, email, name, plan, tier, trial_start, premium_since,
                 premium_until, lifetime, auth_provider, ai_used, ai_extra,
                 usage_month, created_at
            from public.profiles where id = v_uid) p;

  select coalesce(json_agg(to_json(c)), '[]'::json) into v_consents
    from (select consent_id, status, version, ts
            from public.consents where user_id = v_uid order by consent_id) c;

  -- sub/endpoint enthalten den Push-Schlüssel des Geräts. Für die Auskunft
  -- reicht, DASS ein Abo besteht – der Schlüssel ist ein Zugangsgeheimnis und
  -- gehört nicht in eine Datei, die der Nutzer weiterreicht.
  select coalesce(json_agg(to_json(s)), '[]'::json) into v_push
    from (select updated_at, morning, warn
            from public.push_subscriptions where user_id = v_uid) s;

  -- Gleiches gilt für purchase_token: play-verify weist damit gegenüber Google
  -- den Kauf nach. Nur die letzten 6 Zeichen als Beleg für den Nutzer.
  select coalesce(json_agg(to_json(q)), '[]'::json) into v_play
    from (select sku, ptype,
                 right(purchase_token, 6) as token_endet_auf,
                 to_timestamp(expiry_ms / 1000.0) as laeuft_ab, updated_at
            from public.play_purchases where user_id = v_uid) q;

  select fm.family_id into v_fid
    from public.family_members fm where fm.user_id = v_uid limit 1;

  if v_fid is not null then
    select f.data into v_data from public.families f where f.id = v_fid;
    v_data := coalesce(v_data, '{}'::jsonb);

    -- Eigenen Mitgliedseintrag über die stabile authId finden. Gleiche
    -- Zuordnung wie scrub_member_from_family – NICHT über den Namen, der ist
    -- nicht eindeutig.
    select m into v_me
      from jsonb_array_elements(
             case when jsonb_typeof(v_data->'members') = 'array'
                  then v_data->'members' else '[]'::jsonb end) m
     where m->>'authId' = v_uid::text limit 1;
    -- assignee verweist auf die CLIENT-Id des Mitglieds, nicht auf die authId.
    v_meid := v_me->>'id';

    select json_build_object(
      'code',            f.code,
      'beigetreten_am',  fm.joined_at,
      'rolle',           fm.role,
      'plan',            f.plan,
      'plan_bis',        f.plan_until,
      'ich_bin_zahler',  (f.plan_by = v_uid),
      'mein_mitgliedseintrag', v_me,
      'meine_aufgaben', (
        select coalesce(jsonb_agg(t), '[]'::jsonb)
          from jsonb_array_elements(
                 case when jsonb_typeof(v_data->'tasks') = 'array'
                      then v_data->'tasks' else '[]'::jsonb end) t
         where t->>'by' = v_uid::text
            or (v_meid is not null and t->>'assignee' = v_meid)),
      'meine_einkaufsartikel', (
        select coalesce(jsonb_agg(s), '[]'::jsonb)
          from jsonb_array_elements(
                 case when jsonb_typeof(v_data->'shopping') = 'array'
                      then v_data->'shopping' else '[]'::jsonb end) s
         where s->>'by' = v_uid::text),
      'hinweis', 'Gemeinsame Familieneintraege (Anlaesse, Termine, Eintraege anderer Mitglieder) sind bewusst nicht enthalten – Art. 20 Abs. 4 DSGVO schuetzt die Rechte der uebrigen Mitglieder.'
    ) into v_family
    from public.families f
    join public.family_members fm on fm.family_id = f.id and fm.user_id = v_uid
   where f.id = v_fid;
  end if;

  return json_build_object(
    'user_id',        v_uid,
    'profil',         v_profile,
    'einwilligungen', v_consents,
    'push_abos',      v_push,
    'kaeufe',         v_play,
    'familie',        v_family
  );
end $$;

revoke execute on function public.export_my_data() from public, anon;
grant  execute on function public.export_my_data() to authenticated;

notify pgrst, 'reload schema';