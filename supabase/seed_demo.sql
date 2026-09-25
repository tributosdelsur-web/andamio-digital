-- Datos de demo para probar el motor con tu propio WhatsApp.
-- Reemplazá 5491100000000 por TU número (solo dígitos, formato internacional)
-- y corrélo en Supabase → SQL Editor después de la migración.

with c as (
  insert into public.comercios (nombre, rubro, telefono_wa, idioma, estado)
  values ('Comercio Demo', 'autoservicio', '5491100000000', 'es', 'piloto')
  returning id
)
, m as (
  insert into public.comercio_modulos (comercio_id, modulo, config)
  select c.id, x.modulo, x.config from c, (values
    ('chino',  '{"margen_objetivo": 0.30}'::jsonb),
    ('mermas', '{}'::jsonb)
  ) as x(modulo, config)
)
insert into public.usuarios (comercio_id, telefono_wa, nombre, rol)
select id, '5491100000000', 'Dueño demo', 'dueno' from c;
