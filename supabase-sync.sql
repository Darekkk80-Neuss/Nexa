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

-- Obergrenze für user_state.data.
-- families.data ist seit dem 20.07.2026 auf 2 MB begrenzt (save_family in
-- supabase-kids.sql), user_state war es NICHT: hier schreibt der Client per
-- PostgREST direkt in die Tabelle, also ohne Funktion und damit ohne jede
-- Prüfung. Ein Konto konnte beliebig viel JSON ablegen, und statePull lädt das
-- bei jedem Gerätestart komplett herunter.
-- NOT VALID: bereits zu grosse Bestandszeilen sollen diesen Lauf nicht
-- abbrechen. Für INSERT und UPDATE greift die Prüfung trotzdem sofort.
do $ begin
  alter table public.user_state
    add constraint user_state_data_size_chk
    check (octet_length(data::text) <= 2 * 1024 * 1024) not valid;
exception when duplicate_object then null; end $;
