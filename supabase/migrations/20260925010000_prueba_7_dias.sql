-- ============================================================================
-- Andamio Digital · prueba gratuita de 7 días
--
-- Cada comercio nuevo entra en estado 'prueba' por 7 días. El bot avisa por
-- WhatsApp cuando le quedan 2 días y cuando termina (dentro de la ventana de
-- 24 h, así que esos avisos no tienen costo). Al vencer, el bot deja de
-- procesar hasta que el comercio pase a 'piloto' (bonificado, primeros 10) o
-- 'activo' (pago).
-- ============================================================================

alter table public.comercios drop constraint if exists comercios_estado_check;
alter table public.comercios
  add constraint comercios_estado_check
  check (estado in ('prueba', 'piloto', 'activo', 'pausado', 'baja'));

alter table public.comercios alter column estado set default 'prueba';

alter table public.comercios
  add column if not exists prueba_desde  timestamptz not null default now(),
  add column if not exists prueba_hasta  timestamptz not null default now() + interval '7 days',
  add column if not exists aviso_prueba_at timestamptz;   -- último aviso enviado

-- Rubros de referencia (texto libre, esto es solo para que quede documentado):
-- autoservicio, mayorista, barberia, estetica, consultorio, verduleria, feria,
-- gastronomico, almacen
comment on column public.comercios.rubro is
  'autoservicio, mayorista, barberia, estetica, consultorio, verduleria, feria, gastronomico, almacen';

-- Cupo de pilotos bonificados: los primeros 10 comercios
create or replace view public.cupo_pilotos as
select
  10 as cupo,
  count(*) filter (where estado = 'piloto') as usados,
  10 - count(*) filter (where estado = 'piloto') as disponibles
from public.comercios;
revoke all on public.cupo_pilotos from anon, authenticated;
