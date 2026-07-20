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
  created_by uuid references auth.users(id) on delete set null,
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

-- „Ein Nutzer, genau eine Familie" strukturell erzwingen.
-- Der Primärschlüssel (family_id, user_id) lässt zwei Familien FÜR DENSELBEN
-- Nutzer zu. Genau das passiert bei einem Doppelklick auf „Familie erstellen"
-- oder auf zwei Geräten gleichzeitig: beide Transaktionen sehen my_family_id()
-- als leer und legen je eine Familie an. Danach raten acht Funktionen per
-- `limit 1` OHNE `order by`, welche gemeint ist – get_family liest aus der
-- einen, save_family schreibt in die andere, der Kauf landet in der dritten.
do $$
declare v_dupes int;
begin
  select count(*) into v_dupes from (
    select user_id from public.family_members group by user_id having count(*) > 1
  ) d;
  if v_dupes > 0 then
    raise warning 'family_members: % Nutzer sind in mehreren Familien. Unique-Constraint NICHT gesetzt – bitte zuerst bereinigen: select user_id, count(*) from public.family_members group by 1 having count(*) > 1;', v_dupes;
  else
    begin
      alter table public.family_members add constraint family_members_user_uniq unique (user_id);
    exception when duplicate_table or duplicate_object then null;   -- schon vorhanden
    end;
  end if;
end $$;

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
declare v_code text; v_id uuid; v_try int := 0; v_data jsonb; v_upd timestamptz;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  -- IDEMPOTENT: schon in einer Familie? Dann DIESE zurückgeben – niemals eine zweite anlegen
  -- (verhinderte früher Doppel-/Waisenfamilien, wenn der Client den Code lokal nicht mehr kannte).
  v_id := public.my_family_id();
  if v_id is not null then
    select code, data, updated_at into v_code, v_data, v_upd from public.families where id = v_id;
    return json_build_object('code', v_code, 'data', v_data, 'updated_at', v_upd, 'existing', true);
  end if;
  loop
    v_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    exit when not exists (select 1 from public.families where code = v_code);
    v_try := v_try + 1; if v_try > 20 then raise exception 'code generation failed'; end if;
  end loop;
  insert into public.families (code, created_by) values (v_code, auth.uid()) returning id into v_id;
  insert into public.family_members (family_id, user_id, role) values (v_id, auth.uid(), 'adult')
    on conflict (family_id, user_id) do nothing;
  return json_build_object('code', v_code);
end; $$;

-- ------------------------------------------------------------
-- Familie beitreten (per Code). Rückgabe: null wenn Code nicht existiert.
-- ------------------------------------------------------------
create or replace function public.join_family(p_code text)
returns json language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_data jsonb; v_upd timestamptz; v_role text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;

  -- Kindergeräte melden sich anonym an und treten AUSSCHLIESSLICH über
  -- join_as_child bei. Ohne diese Sperre konnte ein Kind mit einem einzigen
  -- RPC-Aufruf zum Erwachsenen werden: der delete/insert unten verlor die
  -- Rolle, die Spalte fiel auf ihren Default 'adult' zurück, und damit waren
  -- save_family, das Familien-KI-Kontingent und Premium entsperrt.
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'not allowed for anonymous sessions';
  end if;

  select id, data, updated_at into v_id, v_data, v_upd from public.families where code = upper(trim(p_code));
  if v_id is null then return null; end if;

  -- Bestehende Rolle bewahren – ein Wechsel der Familie darf niemanden befördern.
  select role into v_role from public.family_members where user_id = auth.uid() limit 1;
  delete from public.family_members where user_id = auth.uid();
  insert into public.family_members (family_id, user_id, role)
  values (v_id, auth.uid(), coalesce(v_role, 'adult'))
  on conflict (family_id, user_id) do nothing;

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
-- save_family — HIER ENTFERNT (bewusst)
-- ------------------------------------------------------------
-- ⚠️ Diese Datei definierte früher eine Version OHNE die Kinder-Sperre. Da sie
--    nach supabase-kids.sql laufen MUSS (Zeile 64 schreibt die Spalte `role`,
--    die dort erst entsteht), überschrieb sie zuverlässig die abgesicherte
--    Fassung – der Kinderschutz war je nach Einspielreihenfolge gar nicht aktiv.
--    Die EINE gültige Definition steht jetzt in supabase-kids.sql.
--    Gleiche Bereinigung wie zuvor bei consume_ai und get_entitlements.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- Familie verlassen
-- ------------------------------------------------------------
create or replace function public.leave_family()
returns void language plpgsql security definer set search_path = public as $$
declare v_fid uuid;
begin
  select family_id into v_fid from public.family_members where user_id = auth.uid() limit 1;
  delete from public.family_members where user_id = auth.uid();
  if v_fid is null then return; end if;

  -- Verlässt der ZAHLER die Familie, muss der Plan mit ihm gehen. Vorher blieb
  -- er bis plan_until stehen, während sync_play_expiry denselben Kauf beim
  -- nächsten App-Start in die neue Familie schrieb: ein Abo schaltete so
  -- nacheinander beliebig viele fremde Familien für je 32 Tage frei.
  update public.families
     set plan = null, plan_until = null, plan_by = null
   where id = v_fid and plan_by = auth.uid();

  -- Sitzplätze der verlassenen Familie neu rechnen – Add-ons hängen am Käufer
  -- und wandern mit ihm. Fehlt die Funktion (ältere Einspielreihenfolge),
  -- bleibt der Austritt trotzdem gültig.
  begin
    perform public.recompute_family_seats_fid(v_fid);
  exception when others then null;
  end;
end; $$;

-- Ausführungsrechte: nur angemeldete Nutzer
revoke execute on function public.create_family(), public.join_family(text), public.get_family(),
  public.save_family(jsonb), public.leave_family(), public.my_family_id() from public, anon;
grant execute on function public.create_family(), public.join_family(text), public.get_family(),
  public.save_family(jsonb), public.leave_family(), public.my_family_id() to authenticated;

-- ------------------------------------------------------------
-- Migration für bereits bestehende Tabellen: created_by-FK auf ON DELETE SET NULL
-- setzen, damit sich Nutzer im Dashboard löschen lassen (sonst blockiert der FK).
-- ------------------------------------------------------------
alter table public.families drop constraint if exists families_created_by_fkey;
alter table public.families
  add constraint families_created_by_fkey
  foreign key (created_by) references auth.users(id) on delete set null;

notify pgrst, 'reload schema';
