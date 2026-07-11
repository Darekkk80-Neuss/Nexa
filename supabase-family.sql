-- ============================================================
-- Effyra – Familien-Synchronisierung (Partner-Sync)
-- Einmalig im Supabase SQL-Editor ausführen ("Run").
-- Erwartetes Ergebnis: "Success. No rows returned"
-- Nur nötig, wenn Familien MIT dem Partner synchronisiert werden sollen.
-- Ohne dieses Script funktioniert die Familienzentrale lokal auf dem Gerät.
-- Das Script kann gefahrlos mehrfach ausgeführt werden.
-- ============================================================

-- ------------------------------------------------------------
-- Tabellen: eine Familie + Zuordnung Nutzer <-> Familie
-- ------------------------------------------------------------
create table if not exists public.families (
  id         uuid primary key default gen_random_uuid(),
  code       text unique not null,
  created_by uuid references auth.users(id),
  data       jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.family_members (
  family_id uuid references public.families(id) on delete cascade,
  user_id   uuid references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (family_id, user_id)
);

-- Direktzugriff komplett sperren – alles läuft über die Funktionen unten
alter table public.families enable row level security;
alter table public.family_members enable row level security;
revoke all on public.families from anon, authenticated;
revoke all on public.family_members from anon, authenticated;

-- ------------------------------------------------------------
-- Hilfsfunktion: die Familie des aktuellen Nutzers
-- ------------------------------------------------------------
create or replace function public.my_family_id()
returns uuid language sql security definer set search_path = public stable as $$
  select family_id from public.family_members where user_id = auth.uid() limit 1;
$$;

-- ------------------------------------------------------------
-- Familie erstellen (erzeugt 6-stelligen Code, macht den Nutzer zum Mitglied)
-- ------------------------------------------------------------
create or replace function public.create_family()
returns json language plpgsql security definer set search_path = public as $$
declare v_code text; v_id uuid; v_try int := 0;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  delete from public.family_members where user_id = auth.uid();   -- vorherige Familie verlassen
  loop
    v_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    exit when not exists (select 1 from public.families where code = v_code);
    v_try := v_try + 1; if v_try > 20 then raise exception 'code generation failed'; end if;
  end loop;
  insert into public.families (code, created_by) values (v_code, auth.uid()) returning id into v_id;
  insert into public.family_members (family_id, user_id) values (v_id, auth.uid());
  return json_build_object('code', v_code);
end; $$;

-- ------------------------------------------------------------
-- Familie beitreten (per Code). Rückgabe: null wenn Code nicht existiert.
-- ------------------------------------------------------------
create or replace function public.join_family(p_code text)
returns json language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_data jsonb; v_upd timestamptz;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select id, data, updated_at into v_id, v_data, v_upd from public.families where code = upper(trim(p_code));
  if v_id is null then return null; end if;
  delete from public.family_members where user_id = auth.uid();
  insert into public.family_members (family_id, user_id) values (v_id, auth.uid()) on conflict do nothing;
  return json_build_object('code', upper(trim(p_code)), 'data', v_data, 'updated_at', v_upd);
end; $$;

-- ------------------------------------------------------------
-- Familie des Nutzers laden
-- ------------------------------------------------------------
create or replace function public.get_family()
returns json language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_code text; v_data jsonb; v_upd timestamptz;
begin
  v_id := public.my_family_id();
  if v_id is null then return null; end if;
  select code, data, updated_at into v_code, v_data, v_upd from public.families where id = v_id;
  return json_build_object('code', v_code, 'data', v_data, 'updated_at', v_upd);
end; $$;

-- ------------------------------------------------------------
-- Gemeinsame Familiendaten speichern
-- ------------------------------------------------------------
create or replace function public.save_family(p_data jsonb)
returns json language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  v_id := public.my_family_id();
  if v_id is null then raise exception 'no family'; end if;
  update public.families set data = p_data, updated_at = now() where id = v_id;
  return json_build_object('updated_at', now());
end; $$;

-- ------------------------------------------------------------
-- Familie verlassen
-- ------------------------------------------------------------
create or replace function public.leave_family()
returns void language plpgsql security definer set search_path = public as $$
begin delete from public.family_members where user_id = auth.uid(); end; $$;

-- Ausführungsrechte: nur angemeldete Nutzer
revoke execute on function public.create_family(), public.join_family(text), public.get_family(),
  public.save_family(jsonb), public.leave_family(), public.my_family_id() from public, anon;
grant execute on function public.create_family(), public.join_family(text), public.get_family(),
  public.save_family(jsonb), public.leave_family(), public.my_family_id() to authenticated;

notify pgrst, 'reload schema';
