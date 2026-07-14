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
  -- alte Codes dieses Kindes in dieser Familie entwerten
  update public.family_child_codes set revoked = true where family_id = v_fid and member_id = p_member_id and not revoked;
  loop
    v_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    exit when not exists (select 1 from public.family_child_codes where code = v_code);
    v_try := v_try + 1; if v_try > 30 then raise exception 'code generation failed'; end if;
  end loop;
  insert into public.family_child_codes (code, family_id, member_id, created_by) values (v_code, v_fid, p_member_id, auth.uid());
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
  select * into v_rec from public.family_child_codes where code = upper(trim(p_code)) and not revoked;
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
declare v_id uuid; v_role text;
begin
  v_id := public.my_family_id();
  if v_id is null then raise exception 'no family'; end if;
  select role into v_role from public.family_members where user_id = auth.uid() and family_id = v_id;
  if v_role = 'child' then raise exception 'children are read-only'; end if;   -- Kindermodus schreibt nicht
  update public.families set data = p_data, updated_at = now() where id = v_id;
  return json_build_object('updated_at', now());
end; $$;

-- Ausführungsrechte
revoke execute on function public.create_child_code(text), public.revoke_child_code(text), public.join_as_child(text) from public, anon;
grant  execute on function public.create_child_code(text), public.revoke_child_code(text) to authenticated;   -- Erwachsene
grant  execute on function public.join_as_child(text) to authenticated;                                       -- anonym angemeldete Kinder (Rolle 'authenticated')

notify pgrst, 'reload schema';

-- ============================================================
-- Fertig. Danach im Client: Erwachsener → Familienzentrale → Kinderprofil → „Kinder-Handy
-- einrichten" (Code). Kind → Login-Seite → „Kind? Mit Code beitreten" → Kindermodus (nur lesend).
-- v2 (optional): child_task_done() für „eigene Aufgabe abhaken" (jsonb-Update, an member_id gebunden).
-- ============================================================
