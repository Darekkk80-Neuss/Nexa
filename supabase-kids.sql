-- ============================================================
-- Effyra – Kinder-Zugang (Kindermodus auf dem Kinder-Handy)
-- Im Supabase SQL-Editor komplett ausführen ("Run"). Idempotent (mehrfach ausführbar).
-- Voraussetzungen: supabase-setup.sql + supabase-family.sql (families, family_members, RPCs).
--
-- WICHTIG – vorher in Supabase aktivieren:
--   Authentication → Providers/Settings → "Anonymous sign-ins" EINSCHALTEN.
--   (Kinder haben KEINE E-Mail/kein 18+-Konto; sie melden sich anonym an und treten
--    per Kinder-Code der Familie in einem eingeschränkten "child"-Modus bei.)
--
-- KONZEPT (bewusst konservativ, DSGVO-Minderjährige):
--   • Ein Erwachsener erzeugt in der Familienzentrale je Kinderprofil einen Kinder-Code.
--   • Das Kind meldet sich ANONYM an und ruft join_as_child(code) → wird als role='child'
--     Mitglied der Familie geführt (an das Kinderprofil member_id gebunden).
--   • Kinder sind in v1 NUR LESEND: save_family ist für sie gesperrt (kein Überschreiben
--     des Familien-Blobs). Sie sehen den geteilten Familienkalender etc., ändern aber nichts.
--   • Der Zugang ist jederzeit widerrufbar (revoke_child_code).
-- ============================================================

-- ------------------------------------------------------------
-- 1) family_members um Rolle + Kinderprofil-Bindung erweitern (additiv; Alt-Zeilen = 'adult')
-- ------------------------------------------------------------
alter table public.family_members add column if not exists role text not null default 'adult';
alter table public.family_members add column if not exists member_id text;   -- Client-Profil-Id des Kindes (bei role='child')
do $$ begin
  alter table public.family_members add constraint family_members_role_chk check (role in ('adult','child'));
exception when duplicate_object then null; end $$;

-- ------------------------------------------------------------
-- 2) Kinder-Codes: je (Familie, Kinderprofil) ein kurzlebiger, widerrufbarer Code
-- ------------------------------------------------------------
create table if not exists public.family_child_codes (
  code       text primary key,
  family_id  uuid not null references public.families(id) on delete cascade,
  member_id  text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked    boolean not null default false
);
-- Ablaufdatum. Ein Kindercode wird per Messenger geteilt und lag bisher
-- unbefristet gültig herum: einmal weitergegeben, funktionierte er Jahre später
-- und auf beliebig vielen Geräten. Es gab nur `revoked`, also einen manuellen
-- Widerruf, den in der Praxis niemand auslöst.
-- 14 Tage reichen zum Einrichten des Kinder-Handys; danach erzeugt ein
-- Erwachsener bei Bedarf einen neuen (create_child_code rotiert ohnehin).
alter table public.family_child_codes add column if not exists expires_at timestamptz;
update public.family_child_codes
   set expires_at = created_at + interval '14 days'
 where expires_at is null;

alter table public.family_child_codes enable row level security;
revoke all on public.family_child_codes from anon, authenticated;   -- Zugriff nur über die Funktionen unten

-- ------------------------------------------------------------
-- 3) create_child_code(member_id): Erwachsener (JWT, in einer Familie) erzeugt/rotiert einen Code
-- ------------------------------------------------------------
create or replace function public.create_child_code(p_member_id text)
returns text language plpgsql security definer set search_path = public as $$
declare v_fid uuid; v_code text; v_try int := 0;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  v_fid := public.my_family_id();
  if v_fid is null then raise exception 'no family'; end if;
  -- Nur Erwachsene duerfen Zugangscodes verwalten (Muster wie in save_family).
  -- Ohne die Prüfung konnte ein Kindergerät sich selbst neue Codes ausstellen
  -- und beliebig viele weitere Geräte in die Familie holen.
  if (select role from public.family_members where user_id = auth.uid() and family_id = v_fid) = 'child'
    then raise exception 'children cannot manage access codes'; end if;
  -- alte Codes dieses Kindes in dieser Familie entwerten
  update public.family_child_codes set revoked = true where family_id = v_fid and member_id = p_member_id and not revoked;
  loop
    v_code := public.gen_family_code(8);   -- siehe supabase-codes.sql (CSPRNG, 31er-Alphabet)
    exit when not exists (select 1 from public.family_child_codes where code = v_code);
    v_try := v_try + 1; if v_try > 30 then raise exception 'code generation failed'; end if;
  end loop;
  insert into public.family_child_codes (code, family_id, member_id, created_by, expires_at)
  values (v_code, v_fid, p_member_id, auth.uid(), now() + interval '14 days');
  return v_code;
end; $$;

-- ------------------------------------------------------------
-- 4) revoke_child_code(member_id): Zugang des Kindes beenden (Codes entwerten + child-Mitgliedschaften lösen)
-- ------------------------------------------------------------
create or replace function public.revoke_child_code(p_member_id text)
returns void language plpgsql security definer set search_path = public as $$
declare v_fid uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  v_fid := public.my_family_id();
  if v_fid is null then return; end if;
  -- Nur Erwachsene duerfen Zugangscodes verwalten (Muster wie in save_family).
  -- Sonst könnte ein Kind den Zugang eines Geschwisterkinds beenden.
  if (select role from public.family_members where user_id = auth.uid() and family_id = v_fid) = 'child'
    then raise exception 'children cannot manage access codes'; end if;
  update public.family_child_codes set revoked = true where family_id = v_fid and member_id = p_member_id;
  delete from public.family_members where family_id = v_fid and role = 'child' and member_id = p_member_id;
end; $$;

-- ------------------------------------------------------------
-- 5) join_as_child(code): vom ANONYM angemeldeten Kind aufgerufen → Familienbeitritt als 'child'
-- ------------------------------------------------------------
create or replace function public.join_as_child(p_code text)
returns json language plpgsql security definer set search_path = public as $$
declare v_rec public.family_child_codes%rowtype; v_data jsonb; v_fcode text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;

  -- Nur ANONYME Sessions duerfen als Kind beitreten. Ohne diese Sperre reicht
  -- ein Fehltipp: ein Erwachsener gibt einen Kindercode ein, das delete/insert
  -- unten setzt seine Rolle auf 'child' – und danach ist er dauerhaft
  -- ausgesperrt, denn save_family, leave_family und join_family lehnen
  -- role='child' alle ab. Der Zahler kaeme nicht mehr in seine eigene
  -- bezahlte Familie. Gegenstueck zur Sperre in join_family.
  if not coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'only anonymous sessions can join as child';
  end if;
  if exists (select 1 from public.family_members where user_id = auth.uid() and coalesce(role, 'adult') <> 'child') then
    raise exception 'adults cannot join as child';
  end if;

  -- Beitrittsversuche begrenzen (siehe supabase-codes.sql): der Kindercode ist
  -- genauso lang wie der Familiencode und öffnet ebenfalls den Familien-Blob.
  if not public.join_rate_ok() then raise exception 'too many attempts'; end if;
  select * into v_rec from public.family_child_codes
   where code = upper(trim(p_code)) and not revoked
     and (expires_at is null or expires_at > now());   -- abgelaufene Codes gelten nicht mehr
  if v_rec.code is null then return null; end if;   -- ungültig/entwertet
  delete from public.family_members where user_id = auth.uid();   -- evtl. vorherige Bindung lösen
  insert into public.family_members (family_id, user_id, role, member_id)
    values (v_rec.family_id, auth.uid(), 'child', v_rec.member_id)
    on conflict (family_id, user_id) do update set role = 'child', member_id = excluded.member_id;
  select data, code into v_data, v_fcode from public.families where id = v_rec.family_id;
  return json_build_object('code', v_fcode, 'member_id', v_rec.member_id, 'data', v_data);
end; $$;

-- ------------------------------------------------------------
-- 6) save_family absichern: Kinder dürfen den Familien-Blob NICHT überschreiben (nur lesen)
--    (Adults/Owner = role 'adult' → unverändert erlaubt.)
-- ------------------------------------------------------------
create or replace function public.save_family(p_data jsonb)
returns json language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_role text; v_size int;
begin
  v_id := public.my_family_id();
  if v_id is null then raise exception 'no family'; end if;
  select role into v_role from public.family_members where user_id = auth.uid() and family_id = v_id;
  if v_role = 'child' then raise exception 'children are read-only'; end if;   -- Kindermodus schreibt nicht

  -- Grössenschranke. Ohne sie konnte ein Mitglied einen beliebig grossen Blob
  -- ablegen, den danach JEDES Familiengerät bei jedem Poll herunterlädt – ein
  -- billiger Weg, die Familie lahmzulegen und Egress zu verbrennen.
  -- 2 MB entspricht mehreren Jahren normaler Nutzung (Aufgaben, Einkaufsliste,
  -- Termine); wer darüber liegt, hat ein Aufräumproblem, kein Speicherproblem.
  v_size := octet_length(p_data::text);
  if v_size > 2 * 1024 * 1024 then
    -- Eigener SQLSTATE statt der Sammelnummer P0001: der Client muss GENAU diesen
    -- Fall erkennen, um einmal aufzuräumen und erneut zu senden. Am Meldungstext
    -- zu erkennen war zu brüchig – der Text ist nicht Teil der Schnittstelle.
    raise exception 'family data too large: % bytes (max 2 MB)', v_size
      using errcode = '54000', hint = 'family_too_large';
  end if;

  -- Plausibilität: der Client schickt immer ein Objekt. Ein Skalar oder Array
  -- wäre ein Fehlaufruf und würde die Familiendaten unbrauchbar machen.
  if jsonb_typeof(p_data) is distinct from 'object' then
    raise exception 'family data must be an object';
  end if;

  -- clock_timestamp() statt now(): now() ist fuer die ganze Transaktion konstant.
  -- apply_family_ops schreibt bereits mit clock_timestamp(); bliebe save_family
  -- bei now(), koennte updated_at ZURUECKfallen – und get_family_since (Vergleich
  -- mit <=) meldete allen Geraeten dauerhaft "unchanged". Die Aenderung kaeme nie an.
  update public.families set data = p_data, updated_at = clock_timestamp() where id = v_id;
  -- Grösse mitgeben: der Client warnt ab ~80 % der Schranke, statt die Nutzerin
  -- erst beim harten Abbruch zu überraschen – da ist die Änderung schon weg.
  return json_build_object('updated_at', now(), 'bytes', v_size);
end; $$;

-- Ausführungsrechte
revoke execute on function public.create_child_code(text), public.revoke_child_code(text), public.join_as_child(text) from public, anon;
grant  execute on function public.create_child_code(text), public.revoke_child_code(text) to authenticated;   -- Erwachsene
revoke execute on function public.save_family(jsonb) from public, anon;
grant  execute on function public.save_family(jsonb) to authenticated;
grant  execute on function public.join_as_child(text) to authenticated;                                       -- anonym angemeldete Kinder (Rolle 'authenticated')

-- ------------------------------------------------------------
-- 7) child_task_done(task_id, done): Kind hakt die EIGENE Familienaufgabe ab (v2).
--    Eng begrenzt: nur eine Aufgabe, deren assignee == member_id des Kindes. Sonst Fehler.
--    Atomarer jsonb-Update auf families.data.tasks – kein Überschreiben des ganzen Blobs.
-- ------------------------------------------------------------
create or replace function public.child_task_done(p_task_id text, p_done boolean default true)
returns json language plpgsql security definer set search_path = public as $$
declare v_fid uuid; v_mid text; v_data jsonb; v_tasks jsonb; v_idx int; v_found boolean := false;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select family_id, member_id into v_fid, v_mid from public.family_members where user_id = auth.uid() and role = 'child';
  if v_fid is null then raise exception 'not a child'; end if;
  select data into v_data from public.families where id = v_fid for update;
  v_tasks := coalesce(v_data->'tasks', '[]'::jsonb);
  for v_idx in 0 .. greatest(jsonb_array_length(v_tasks) - 1, -1) loop
    if (v_tasks->v_idx->>'id') = p_task_id then
      if (v_tasks->v_idx->>'assignee') is distinct from v_mid then raise exception 'not your task'; end if;   -- nur eigene
      v_tasks := jsonb_set(v_tasks, array[v_idx::text, 'done'], to_jsonb(coalesce(p_done, true)));
      v_found := true; exit;
    end if;
  end loop;
  if not v_found then raise exception 'task not found'; end if;
  -- clock_timestamp(): siehe save_family. Sonst verschwindet ausgerechnet das
  -- Haekchen des Kindes still, weil die anderen Geraete "unchanged" bekommen.
  update public.families set data = jsonb_set(v_data, '{tasks}', v_tasks), updated_at = clock_timestamp() where id = v_fid;
  return json_build_object('ok', true);
end; $$;
revoke execute on function public.child_task_done(text, boolean) from public, anon;
grant  execute on function public.child_task_done(text, boolean) to authenticated;

notify pgrst, 'reload schema';

-- ============================================================
-- Fertig. Danach im Client: Erwachsener → Familienzentrale → Kinderprofil → „Kinder-Handy
-- einrichten" (Code). Kind → Login-Seite → „Kind? Mit Code beitreten" → Kindermodus.
-- Kind kann jetzt die EIGENEN Familienaufgaben abhaken (child_task_done); sonst nur Ansicht.
-- ============================================================
