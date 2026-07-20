-- ============================================================
-- Effyra – Familiendaten nebenläufig schreiben (Delta statt Voll-Blob)
-- Im Supabase SQL-Editor komplett ausführen ("Run"). Idempotent (mehrfach ausführbar).
-- REIHENFOLGE: NACH supabase-family.sql (#5) und supabase-kids.sql (#6).
--
-- WARUM: families.data ist EIN jsonb-Dokument. save_family (supabase-kids.sql)
-- schrieb es komplett neu, ohne zu prüfen, ob inzwischen jemand anderes
-- geschrieben hat. Der Hintergrund-Poll des Clients läuft mit 45–240 s Backoff,
-- das Überschreib-Fenster war also bis zu vier Minuten breit: zwei Erwachsene
-- tragen je eine Aufgabe ein, die zweite Speicherung löscht die erste – ohne
-- Fehlermeldung, auf beiden Geräten. Dasselbe machte jeder Voll-Blob-Push das
-- Abhaken durch ein Kind (child_task_done) wieder rückgängig.
--
-- apply_family_ops nimmt statt des Blobs nur die Änderung entgegen (je Liste:
-- geschriebene Einträge + gelöschte Ids) und führt sie unter Zeilensperre in den
-- AKTUELLEN Stand ein. Zwei Geräte, die verschiedene Einträge anfassen,
-- verlieren damit nichts mehr. Fassen beide DENSELBEN Eintrag an, gewinnt
-- weiterhin der zweite Schreiber – aber nur für diesen einen Eintrag statt für
-- die ganze Familie.
--
-- save_family bleibt bewusst UNVERÄNDERT bestehen: bereits ausgelieferte Clients
-- rufen es weiter auf, und der neue Client fällt darauf zurück, solange diese
-- Datei nicht eingespielt ist. Hier wird KEINE bestehende Funktion neu definiert.
-- ============================================================

create or replace function public.apply_family_ops(p_ops jsonb)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_role text; v_data jsonb; v_upd timestamptz;
  v_key text; v_op jsonb; v_list jsonb; v_up jsonb; v_del jsonb; v_size int;
begin
  v_id := public.my_family_id();
  if v_id is null then raise exception 'no family'; end if;

  -- Dieselbe Sperre wie in save_family: der Kindermodus ist NUR LESEND (einzige
  -- Ausnahme bleibt child_task_done). Ohne diese Prüfung wäre der Kinderschutz
  -- über die neue Funktion schlicht umgehbar.
  select role into v_role from public.family_members where user_id = auth.uid() and family_id = v_id;
  if v_role = 'child' then raise exception 'children are read-only'; end if;

  if jsonb_typeof(p_ops) is distinct from 'object' then raise exception 'ops must be an object'; end if;

  -- Eingangsgrösse begrenzen, BEVOR irgendetwas entpackt wird.
  v_size := octet_length(p_ops::text);
  if v_size > 2 * 1024 * 1024 then raise exception 'family ops too large: % bytes (max 2 MB)', v_size; end if;

  -- for update serialisiert konkurrierende Schreiber auf GENAU DIESE Familie.
  -- Dasselbe Muster nutzt child_task_done in supabase-kids.sql bereits.
  select data into v_data from public.families where id = v_id for update;
  if v_data is null then raise exception 'no family'; end if;
  if jsonb_typeof(v_data) is distinct from 'object' then v_data := '{}'::jsonb; end if;

  foreach v_key in array array['members','occasions','tasks','shopping','events'] loop
    v_op := p_ops -> v_key;
    continue when v_op is null;   -- Liste nicht angefasst → unverändert stehen lassen
    if jsonb_typeof(v_op) is distinct from 'object' then raise exception 'ops.% must be an object', v_key; end if;

    v_up  := case when jsonb_typeof(v_op->'upsert') = 'array' then v_op->'upsert' else '[]'::jsonb end;
    v_del := case when jsonb_typeof(v_op->'delete') = 'array' then v_op->'delete' else '[]'::jsonb end;

    -- Ohne id lässt sich ein Eintrag nicht zuordnen. Stillschweigend anhängen
    -- würde bei jedem Sync eine weitere Dublette erzeugen – lieber laut scheitern.
    if exists (
      select 1 from jsonb_array_elements(v_up) u
       where jsonb_typeof(u) <> 'object' or coalesce(u->>'id','') = ''
    ) then
      raise exception 'ops.%: every upsert needs an id', v_key;
    end if;

    v_list := case when jsonb_typeof(v_data->v_key) = 'array' then v_data->v_key else '[]'::jsonb end;

    -- 1) Bestehende Einträge AN IHRER STELLE ersetzen, gelöschte entfernen.
    --    Die Reihenfolge muss erhalten bleiben: Einkaufsliste und Anlässe zeigt
    --    der Client in Blob-Reihenfolge an, ein Anhängen würde sie durchmischen.
    select coalesce(jsonb_agg(coalesce(x.neu, l.e) order by l.ord), '[]'::jsonb)
      into v_list
      from jsonb_array_elements(v_list) with ordinality as l(e, ord)
      left join lateral (
        select u as neu from jsonb_array_elements(v_up) u
         where u->>'id' = l.e->>'id' limit 1
      ) x on true
     where coalesce(l.e->>'id','') = ''            -- id-lose Altlast: nicht anfassen, nicht wegwerfen
        or not jsonb_exists(v_del, l.e->>'id');

    -- 2) Nur wirklich Neues anhängen – alles Vorhandene wurde oben ersetzt.
    select v_list || coalesce(jsonb_agg(n.e order by n.ord), '[]'::jsonb)
      into v_list
      from jsonb_array_elements(v_up) with ordinality as n(e, ord)
     where not exists (select 1 from jsonb_array_elements(v_list) o where o->>'id' = n.e->>'id');

    v_data := jsonb_set(v_data, array[v_key], v_list);
  end loop;

  -- shopAssign ist kein Listeneintrag, sondern ein einzelner Wert: hier gilt
  -- weiterhin "letzter Schreiber gewinnt", aber nur für dieses eine Feld.
  if jsonb_exists(p_ops, 'shopAssign') then
    v_data := jsonb_set(v_data, '{shopAssign}', coalesce(p_ops->'shopAssign', 'null'::jsonb));
  end if;

  -- tidy (Aufraeum-Regel) wie shopAssign durchreichen: es ist ein einzelner Wert,
  -- keine Liste. Ohne diese Weiche kaeme der Schalter ueber den NEUEN Sendeweg
  -- nie beim Server an und waere still geraetelokal - genau das, was die
  -- familienweite Regel verhindern soll.
  if jsonb_exists(p_ops, 'tidy') then
    v_data := jsonb_set(v_data, '{tidy}', coalesce(p_ops->'tidy', 'null'::jsonb));
  end if;

  -- Dieselbe Grössenschranke wie save_family, jetzt auf dem ZUSAMMENGEFÜHRTEN
  -- Stand: sonst liesse sich das 2-MB-Limit in kleinen Schritten umgehen.
  v_size := octet_length(v_data::text);
  if v_size > 2 * 1024 * 1024 then
    -- errcode UND hint wie in save_family (supabase-kids.sql): der Client
    -- unterscheidet daran "zu gross" von einem Netz- oder Rechtefehler und
    -- raeumt genau in diesem Fall einmal hart auf. Ohne den Code waere
    -- apply_family_ops als neuer HAUPTweg der einzige ohne diese Rueckmeldung.
    raise exception 'family data too large: % bytes (max 2 MB)', v_size
      using errcode = '54000', hint = 'family_too_large';
  end if;

  -- clock_timestamp() statt now(): now() ist für die ganze Transaktion konstant.
  -- Zwei im selben Moment gestartete Schreiber bekämen denselben Zeitstempel –
  -- und get_family_since (supabase-optimierung.sql) vergleicht mit "<=", der
  -- zweite Stand wäre für den Client dauerhaft "unverändert" und käme nie an.
  -- Unter der Zeilensperre oben ist clock_timestamp() streng monoton.
  update public.families set data = v_data, updated_at = clock_timestamp()
   where id = v_id
   returning updated_at into v_upd;

  -- Den zusammengeführten Stand mitgeben: der Client übernimmt genau ihn als
  -- neue Vergleichsgrundlage und spart sich den sofort folgenden Pull.
  -- bytes: Grundlage fuer die Fruehwarnung im Client (famWarnSize ab ~80 %).
  return json_build_object('updated_at', v_upd, 'data', v_data, 'bytes', v_size);
end; $$;

revoke execute on function public.apply_family_ops(jsonb) from public, anon;
grant  execute on function public.apply_family_ops(jsonb) to authenticated;

notify pgrst, 'reload schema';
