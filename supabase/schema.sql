-- Ejecutar esto en Supabase → SQL Editor → New query → Run

create table quiz_responses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  score int not null,
  total int not null,
  detail jsonb not null
);

-- Habilita seguridad a nivel de fila (obligatorio en Supabase)
alter table quiz_responses enable row level security;

-- Permite que cualquiera con la clave pública (publishable) guarde una respuesta
create policy "Cualquiera puede guardar su respuesta"
  on quiz_responses
  for insert
  to anon
  with check (true);

-- Permite que cualquiera con la clave pública lea las respuestas (para el panel admin)
create policy "Cualquiera puede leer las respuestas"
  on quiz_responses
  for select
  to anon
  using (true);

-- NOTA: esto deja las respuestas visibles a cualquiera que tenga la URL y la clave
-- pública del proyecto (no hay usuarios/login). Para un equipo chico e interno como
-- el tuyo es un nivel de exposición razonable, pero si más adelante esto crece,
-- conviene agregar autenticación real antes del panel admin.
