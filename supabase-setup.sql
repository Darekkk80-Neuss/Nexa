-- ============================================================
-- Effyra – Supabase-Backend-Setup  (Version 2, wiederholbar)
-- Kompletten Inhalt im Supabase SQL-Editor ausführen ("Run").
-- Erwartetes Ergebnis unten: "Success. No rows returned"
-- Das Script kann gefahrlos mehrfach ausgeführt werden.
-- ============================================================

-- Für SHA-256-Hashing der Freischalt-Codes (liegt bei Supabase im Schema "extensions")
create extension if not exists pgcrypto with schema extensions;

-- ------------------------------------------------------------
-- 1) Profil-Tabelle: ein Datensatz pro Nutzer
--    (plan und trial_start sind vom Nutzer NICHT direkt änderbar)
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text,
  name          text,
  plan          text        not null default 'free' check (plan in ('free','premium')),
  trial_start   timestamptz not null default now(),
  premium_since timestamptz,
  created_at    timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Jeder Nutzer sieht nur sein eigenes Profil
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select using (auth.uid() = id);

-- Nutzer dürfen nur die Spalte "name" ihres eigenen Profils ändern
drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

revoke insert, update, delete on public.profiles from anon, authenticated;
grant  select               on public.profiles to authenticated;
grant  update (name)        on public.profiles to authenticated;

-- ------------------------------------------------------------
-- 2) Automatik: Bei jeder Registrierung wird das Profil angelegt
--    und die 3-Tage-Testphase gestartet (serverseitig!)
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Profile für Nutzer nachtragen, die sich schon vorher registriert haben
insert into public.profiles (id, email, name)
select u.id, u.email, coalesce(u.raw_user_meta_data->>'name', '')
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

-- ------------------------------------------------------------
-- 3) Premium-Codes (nur als SHA-256-Hash gespeichert, einmalig einlösbar)
--    Niemand kann die Tabelle direkt lesen oder schreiben.
-- ------------------------------------------------------------
create table if not exists public.premium_codes (
  code_hash text primary key,
  used_by   uuid references auth.users(id) on delete set null,
  used_at   timestamptz
);

alter table public.premium_codes enable row level security;
revoke all on public.premium_codes from anon, authenticated;

-- Die 5 Start-Codes (identisch zu den bisherigen NEXA-Codes)
insert into public.premium_codes (code_hash) values
  ('19d0030aea66bc3f6f6c244ed7ba921fe0f28cb0b4ea40b9084ab944b8352a2d'),
  ('8e5f5051706e095e49fcd320cf82d6aff9e8a32a8c46eb9119e1b345589a6c5e'),
  ('d0ee8addd0f56f661264aad40de71a15687f1e2af1913aaf45c846df5fdd592f'),
  ('1cef3964c45a38fa7a522baa9d28ed3cd58facea7b80b079da73826b6d003cec'),
  ('2d259593da59c9caa11b65215a22064ec5a604064bd0b04ab3bd7b27b2282d1a')
on conflict (code_hash) do nothing;

-- ------------------------------------------------------------
-- 4) Code einlösen – läuft serverseitig, nicht austricksbar.
--    Rückgabe: 'ok' | 'invalid' | 'already_used' | 'not_authenticated'
-- ------------------------------------------------------------
create or replace function public.redeem_code(p_code text)
returns text
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  v_hash  text;
  v_found public.premium_codes%rowtype;
begin
  if auth.uid() is null then
    return 'not_authenticated';
  end if;

  v_hash := encode(extensions.digest(upper(trim(p_code)), 'sha256'), 'hex');

  select * into v_found from public.premium_codes where code_hash = v_hash;
  if not found then
    return 'invalid';
  end if;

  if v_found.used_by is not null and v_found.used_by <> auth.uid() then
    return 'already_used';
  end if;

  update public.premium_codes
     set used_by = auth.uid(), used_at = now()
   where code_hash = v_hash;

  update public.profiles
     set plan = 'premium', premium_since = now()
   where id = auth.uid();

  return 'ok';
end;
$$;

revoke execute on function public.redeem_code(text) from public, anon;
grant  execute on function public.redeem_code(text) to authenticated;

-- PostgREST-Schema-Cache sofort aktualisieren
notify pgrst, 'reload schema';

-- ============================================================
-- Fertig! So legst du später NEUE Premium-Codes an
-- (Code frei wählen, Format egal – Empfehlung: NEXA-XXXX-XXXX):
--
--   insert into public.premium_codes (code_hash)
--   values (encode(extensions.digest(upper('NEXA-DEIN-CODE'), 'sha256'), 'hex'));
--
-- ============================================================
