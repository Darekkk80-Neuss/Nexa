-- ============================================================================
-- Effyra – Trial-Missbrauchsschutz
-- ----------------------------------------------------------------------------
-- Schliesst zwei Luecken:
--   A) Konto loeschen und mit DERSELBEN Adresse neu anmelden gab bisher einen
--      frischen 7-Tage-Trial. delete-account kennt "trial" bislang null Mal.
--   B) Trial gab es fuer jede beliebige, unbestaetigte E-Mail-Adresse.
--
-- Ansatz bewusst OHNE Geraete-Fingerprinting: das faellt unter § 25 TDDDG /
-- Art. 5(3) ePrivacy-RL (auch bei lokalem Hashing) und ist weder von der DSK
-- noch vom EDSA fuer die Missbrauchsabwehr freigegeben. Hier wird ausschliesslich
-- die E-Mail-Adresse verwendet, die ohnehin verarbeitet wird – gepfeffert gehasht,
-- also nicht rueckrechenbar, mit Loeschfrist.
--
-- Reihenfolge: NACH supabase-setup.sql und supabase-trial-and-play.sql ausfuehren.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- 1) Pfeffer -----------------------------------------------------------------
--    Ohne Pfeffer liesse sich aus einem Hash per Woerterbuchangriff die Adresse
--    zurueckrechnen. Die Tabelle ist fuer niemanden lesbar ausser service_role.
create table if not exists public.trial_pepper (
  id    int primary key default 1,
  value text not null,
  constraint trial_pepper_einzeilig check (id = 1)
);
alter table public.trial_pepper enable row level security;
insert into public.trial_pepper (id, value)
  values (1, encode(extensions.gen_random_bytes(32), 'hex'))
  on conflict (id) do nothing;

-- 2) Register bereits vergebener Trials --------------------------------------
--    KEIN Fremdschluessel auf auth.users – die Zeile MUSS die Kontoloeschung
--    ueberleben, sonst ist der ganze Schutz wirkungslos.
create table if not exists public.trial_ledger (
  id_hash     text primary key,
  first_seen  timestamptz not null default now(),
  claims      int not null default 1,
  last_seen   timestamptz not null default now()
);
alter table public.trial_ledger enable row level security;
comment on table public.trial_ledger is
  'Missbrauchsabwehr Testphase (Art. 6 Abs. 1 lit. f DSGVO). Enthaelt nur gepfefferte '
  'SHA-256-Hashes der E-Mail-Adresse, keine Klardaten. Loeschung nach 24 Monaten '
  'ohne erneuten Kontakt via trial_ledger_aufraeumen().';

-- 3) Hilfsfunktionen ---------------------------------------------------------
create or replace function public.trial_id_hash(p_email text)
returns text language sql security definer set search_path = public, extensions as $$
  select encode(
    extensions.digest(lower(trim(p_email)) || (select value from public.trial_pepper where id = 1), 'sha256'),
    'hex');
$$;

-- Schalter: Testphase nur fuer Konten mit verifizierter Identitaet (Google-Anmeldung
-- oder bestaetigte E-Mail). Auf false setzen, wenn jedes Konto den Trial bekommen soll.
create or replace function public.trial_requires_verified()
returns boolean language sql immutable as $$ select true $$;

-- 4) Registrierungs-Trigger ersetzen -----------------------------------------
--    Ergaenzt das bisherige Verhalten (Profil anlegen), setzt zusaetzlich trial_start:
--      • Adresse schon einmal dagewesen  -> trial_start = damaliger Erstkontakt
--                                            (die 7 Tage sind damit schon abgelaufen)
--      • Identitaet nicht verifiziert     -> trial_start weit in der Vergangenheit
--      • sonst                            -> now(), also voller Trial
alter table public.profiles add column if not exists auth_provider text;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  v_hash     text;
  v_first    timestamptz;
  v_provider text;
  v_verified boolean;
  v_start    timestamptz;
begin
  v_provider := coalesce(new.raw_app_meta_data->>'provider', 'email');
  -- Verifiziert ist: Anmeldung ueber einen externen Anbieter (Google prueft die
  -- Adresse selbst) ODER eine per Bestaetigungsmail bestaetigte Adresse.
  v_verified := (v_provider <> 'email') or (new.email_confirmed_at is not null);

  if new.email is null or new.email = '' then
    v_start := now();                      -- anonyme Sessions (Kindermodus) unberuehrt lassen
  else
    v_hash := public.trial_id_hash(new.email);
    select first_seen into v_first from public.trial_ledger where id_hash = v_hash;

    if v_first is not null then
      v_start := v_first;                  -- Wiederkehrer: Trial laeuft ab Erstkontakt
      update public.trial_ledger
         set claims = claims + 1, last_seen = now()
       where id_hash = v_hash;
    elsif public.trial_requires_verified() and not v_verified then
      v_start := timestamptz '2000-01-01'; -- unbestaetigt: kein Trial, Konto aber nutzbar
    else
      v_start := now();
      insert into public.trial_ledger (id_hash) values (v_hash)
        on conflict (id_hash) do nothing;
    end if;
  end if;

  insert into public.profiles (id, email, name, trial_start, auth_provider)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', ''), v_start, v_provider)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- 5) Nachtraegliche Bestaetigung -------------------------------------------
--    Wer sich per E-Mail registriert und die Adresse SPAETER bestaetigt, soll den
--    Trial dann bekommen – aber nur beim ersten Mal.
create or replace function public.handle_user_confirmed()
returns trigger
language plpgsql
security definer set search_path = public, extensions
as $$
declare v_hash text;
begin
  if new.email_confirmed_at is not null and old.email_confirmed_at is null and new.email is not null then
    v_hash := public.trial_id_hash(new.email);
    if not exists (select 1 from public.trial_ledger where id_hash = v_hash) then
      insert into public.trial_ledger (id_hash) values (v_hash) on conflict (id_hash) do nothing;
      update public.profiles set trial_start = now()
       where id = new.id and trial_start < timestamptz '2001-01-01';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed
  after update of email_confirmed_at on auth.users
  for each row execute function public.handle_user_confirmed();

-- 6) Bestandsschutz ----------------------------------------------------------
--    Vorhandene Konten behalten ihren Trial und kommen ins Register, damit sie
--    nach einer Loeschung keinen neuen bekommen.
insert into public.trial_ledger (id_hash, first_seen, last_seen)
select public.trial_id_hash(p.email), coalesce(p.trial_start, now()), now()
  from public.profiles p
 where p.email is not null and p.email <> ''
on conflict (id_hash) do nothing;

update public.profiles p
   set auth_provider = coalesce(p.auth_provider,
       (select coalesce(u.raw_app_meta_data->>'provider', 'email') from auth.users u where u.id = p.id))
 where p.auth_provider is null;

-- 7) Loeschfrist -------------------------------------------------------------
--    Art. 5 Abs. 1 lit. e DSGVO: nicht laenger speichern als noetig.
--    Per pg_cron monatlich einplanen oder manuell aufrufen.
create or replace function public.trial_ledger_aufraeumen()
returns int language sql security definer set search_path = public as $$
  with weg as (delete from public.trial_ledger where last_seen < now() - interval '24 months' returning 1)
  select count(*)::int from weg;
$$;

revoke all on function public.trial_ledger_aufraeumen() from public, anon, authenticated;
revoke all on function public.trial_id_hash(text)        from public, anon, authenticated;
