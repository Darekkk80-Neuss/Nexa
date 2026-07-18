CREATE OR REPLACE FUNCTION public.create_child_code(p_member_id text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_fid uuid; v_code text; v_try int := 0;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  v_fid := public.my_family_id();
  if v_fid is null then raise exception 'no family'; end if;
  -- Nur Erwachsene duerfen Zugangscodes verwalten (Muster wie in save_family)
  if (select role from public.family_members where user_id = auth.uid() and family_id = v_fid) = 'child'
    then raise exception 'children cannot manage access codes'; end if;
  -- alte Codes dieses Kindes in dieser Familie entwerten
  update public.family_child_codes set revoked = true where family_id = v_fid and member_id = p_member_id and not revoked;
  loop
    v_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    exit when not exists (select 1 from public.family_child_codes where code = v_code);
    v_try := v_try + 1; if v_try > 30 then raise exception 'code generation failed'; end if;
  end loop;
  insert into public.family_child_codes (code, family_id, member_id, created_by) values (v_code, v_fid, p_member_id, auth.uid());
  return v_code;
end; $function$;

CREATE OR REPLACE FUNCTION public.revoke_child_code(p_member_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_fid uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  v_fid := public.my_family_id();
  if v_fid is null then return; end if;
  -- Nur Erwachsene duerfen Zugangscodes verwalten (Muster wie in save_family)
  if (select role from public.family_members where user_id = auth.uid() and family_id = v_fid) = 'child'
    then raise exception 'children cannot manage access codes'; end if;
  update public.family_child_codes set revoked = true where family_id = v_fid and member_id = p_member_id;
  delete from public.family_members where family_id = v_fid and role = 'child' and member_id = p_member_id;
end; $function$;
