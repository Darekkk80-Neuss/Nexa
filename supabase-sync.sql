-- Effyra – Cloud-State-Sync (Mehrgeräte-Backup pro Nutzer)
-- Einmal im Supabase SQL-Editor ausführen (Projekt ocnlrxmosbbtsczjyvxb).
-- Speichert pro Nutzer einen JSON-Zustand; RLS erlaubt jedem NUR die eigene Zeile.
-- Sensible Bereiche (Notfall, Budget) und Dokumente bleiben clientseitig ausgeschlossen.

create table if not exists public.user_state (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_state enable row level security;

-- Nur eigene Zeile lesen
drop policy if exists "user_state_select_own" on public.user_state;
create policy "user_state_select_own" on public.user_state
  for select using (auth.uid() = user_id);

-- Nur eigene Zeile anlegen
drop policy if exists "user_state_insert_own" on public.user_state;
create policy "user_state_insert_own" on public.user_state
  for insert with check (auth.uid() = user_id);

-- Nur eigene Zeile ändern
drop policy if exists "user_state_update_own" on public.user_state;
create policy "user_state_update_own" on public.user_state
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
