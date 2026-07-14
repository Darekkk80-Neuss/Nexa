-- ============================================================
-- Effyra – Server-Cache für EffyraFit-Fotos (Pexels), OPTIONAL.
-- Ohne dieses Script funktioniert der Foto-Proxy trotzdem (holt dann jedes Mal frisch,
-- der Client cached wöchentlich). Mit der Tabelle wird Pexels nur ~1×/Woche für ALLE
-- Nutzer angefragt → skaliert auch bei vielen Nutzern.
-- Einmalig im Supabase SQL-Editor ausführen. Mehrfach ausführbar.
-- ============================================================

create table if not exists public.photo_cache (
  key        text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- Direktzugriff sperren – nur die Edge Function (Service-Role) liest/schreibt.
alter table public.photo_cache enable row level security;
revoke all on public.photo_cache from anon, authenticated;
