
-- ============================================================
-- Panel admin protegido (26/09/2026)
-- Antes cualquiera con la clave pública podía leer las respuestas
-- (nombres y contactos de postulantes). Ahora solo las cuentas
-- listadas en la tabla admins, después de iniciar sesión.
-- ============================================================

create table if not exists admins (
  email text primary key check (email = lower(email))
);
alter table admins enable row level security;
-- sin políticas: nadie la lee ni la escribe desde el sitio

create or replace function es_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where email = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;
revoke all on function es_admin() from public;
grant execute on function es_admin() to anon, authenticated;

drop policy if exists "Cualquiera puede leer las respuestas" on quiz_responses;
drop policy if exists "Solo admins leen las respuestas" on quiz_responses;
create policy "Solo admins leen las respuestas"
  on quiz_responses for select to authenticated
  using (es_admin());

-- Las solicitudes de prueba del sitio también quedan visibles solo para admins
do $$ begin
  if to_regclass('public.solicitudes_prueba') is not null then
    execute 'drop policy if exists "Solo admins leen solicitudes" on solicitudes_prueba';
    execute 'create policy "Solo admins leen solicitudes" on solicitudes_prueba for select to authenticated using (es_admin())';
  end if;
end $$;

-- Cambiá el email por el tuyo (en minúsculas). Después creá ese mismo usuario en
-- Authentication → Users → Add user → Create new user (email + contraseña, "Auto Confirm").
insert into admins (email) values ('CAMBIAR@tu-email.com') on conflict do nothing;
