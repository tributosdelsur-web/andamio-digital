-- ============================================================================
-- Andamio Digital · Etiqueta Visión, prenda por prenda: fotos, QR, entregas y cobro
--
--   * Cada prenda lleva una etiqueta con QR que abre WhatsApp con su código.
--     Cada escaneo avanza la operación: stock → reserva (retiro o envío) →
--     en camino → entregada. Todo queda en articulo_eventos (quién y cuándo).
--   * Los envíos los hace el comercio con la empresa que ya usa (PedidosYa,
--     Uber, moto propia…); Andamio solo registra el estado y una nota.
--   * Dos formas de identificar la prenda (comercio_modulos.config.etiquetas):
--       'propias' (por defecto): la tienda sigue con sus etiquetas de precio; el bot
--                 lee el precio y describe la prenda en la foto, y calcula el peso.
--       'qr':     el bot manda una etiqueta con QR para imprimir.
--   * Cobro: cuota base con prendas incluidas + un monto por prenda extra
--     (plan_prendas), según prendas dadas de alta en el mes.
-- ============================================================================

-- Estados nuevos: en_camino y entregado
alter table public.articulos drop constraint if exists articulos_estado_check;
alter table public.articulos add constraint articulos_estado_check
  check (estado in ('en_stock', 'reservado', 'en_camino', 'vendido', 'entregado', 'baja'));

alter table public.articulos
  add column if not exists entrega text check (entrega in ('local', 'retiro', 'envio')),
  add column if not exists envio_nota text,          -- empresa, link de seguimiento, zona
  add column if not exists etiqueta_path text,       -- PNG de la etiqueta con QR (bucket catalogo)
  add column if not exists descripcion_zh text;      -- descripción corta en chino (la hace la IA)

-- Los códigos pasan a ser únicos en todo Andamio: así un comprador que escanea
-- el QR llega a la prenda correcta sin saber de qué tienda es.
create or replace function public.nuevo_codigo_articulo(p_comercio uuid)
returns text language plpgsql volatile as $$
declare
  alfabeto constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  c text;
  intentos int := 0;
begin
  loop
    c := '';
    for i in 1..5 loop
      c := c || substr(alfabeto, 1 + floor(random() * length(alfabeto))::int, 1);
    end loop;
    exit when not exists (select 1 from public.articulos a where a.codigo = c);
    intentos := intentos + 1;
    if intentos > 20 then raise exception 'No se pudo generar un código único'; end if;
  end loop;
  return c;
end $$;
create unique index if not exists articulos_codigo_global on public.articulos (codigo);

-- Fecha de venta: al vender en el local, al salir el envío o al entregar.
-- Si vuelve al stock o a reserva, se limpia.
create or replace function public.articulos_codigo_default()
returns trigger language plpgsql as $$
begin
  if new.codigo is null or new.codigo = '' then
    new.codigo := public.nuevo_codigo_articulo(new.comercio_id);
  end if;
  new.codigo := upper(new.codigo);
  if new.estado in ('vendido', 'en_camino', 'entregado') then
    new.vendido_at := coalesce(new.vendido_at, now());
  elsif new.estado in ('en_stock', 'reservado') then
    new.vendido_at := null;
  end if;
  if new.estado = 'en_stock' then
    new.entrega := null;
  end if;
  return new;
end $$;

-- Traza de cada prenda
create table if not exists public.articulo_eventos (
  id          bigserial primary key,
  articulo_id uuid not null references public.articulos(id) on delete cascade,
  comercio_id uuid not null references public.comercios(id) on delete cascade,
  evento      text not null check (evento in
                ('alta', 'en_stock', 'reservado', 'en_camino', 'vendido', 'entregado', 'baja', 'correccion')),
  entrega     text check (entrega in ('local', 'retiro', 'envio')),
  telefono    text,                                   -- quién lo hizo
  mensaje_id  uuid references public.mensajes(id) on delete set null,
  foto_path   text,
  nota        text,
  created_at  timestamptz not null default now()
);
create index if not exists articulo_eventos_idx on public.articulo_eventos (articulo_id, created_at);
alter table public.articulo_eventos enable row level security;

-- Resumen para el dueño: ventas incluye lo enviado y lo entregado
create or replace view public.inventario_prendas as
select comercio_id,
       count(*) filter (where estado = 'en_stock')             as en_stock,
       coalesce(sum(peso_kg) filter (where estado = 'en_stock'), 0) as kg_en_stock,
       coalesce(sum(precio)  filter (where estado = 'en_stock'), 0) as valor_en_stock,
       count(*) filter (where estado in ('vendido', 'en_camino', 'entregado')
                          and vendido_at >= date_trunc('week', now())) as vendidos_semana,
       coalesce(sum(precio) filter (where estado in ('vendido', 'en_camino', 'entregado')
                          and vendido_at >= date_trunc('week', now())), 0) as ventas_semana,
       count(*) filter (where estado = 'reservado')            as reservadas,
       count(*) filter (where estado = 'en_camino')            as en_camino
from public.articulos
group by comercio_id;
revoke all on public.inventario_prendas from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Cobro de este modo: cuota base con N prendas incluidas + USD por prenda extra,
-- contando prendas dadas de alta en el mes (hora de Buenos Aires). Un solo plan
-- general; un comercio puede tener otro en comercio_modulos.config.plan.
-- ---------------------------------------------------------------------------
create table if not exists public.plan_prendas (
  id              boolean primary key default true check (id),   -- una sola fila
  cuota_base_usd  numeric(10,2) not null check (cuota_base_usd >= 0),
  incluidas       int not null check (incluidas >= 0),
  por_prenda_usd  numeric(10,4) not null check (por_prenda_usd >= 0),
  techo_usd       numeric(10,2) check (techo_usd > 0)            -- null = sin techo
);
insert into public.plan_prendas (cuota_base_usd, incluidas, por_prenda_usd, techo_usd)
values (37, 300, 0.40, null)
on conflict (id) do nothing;
alter table public.plan_prendas enable row level security;

drop view if exists public.facturacion_prendas;
drop function if exists public.uso_prendas(uuid, date);
create or replace function public.uso_prendas(p_comercio uuid, p_mes date default null)
returns table (mes date, altas bigint, incluidas int, extra bigint, cuota_base_usd numeric,
               por_prenda_usd numeric, techo_usd numeric, cuota_usd numeric)
language sql stable security definer set search_path = public as $$
  with m as (
    select date_trunc('month', coalesce(p_mes, (now() at time zone 'America/Argentina/Buenos_Aires')::date))::date as desde
  ), a as (
    select count(*) as n from public.articulos x, m
    where x.comercio_id = p_comercio
      and (x.created_at at time zone 'America/Argentina/Buenos_Aires') >= m.desde
      and (x.created_at at time zone 'America/Argentina/Buenos_Aires') <  (m.desde + interval '1 month')
  ), p as (
    -- Plan propio del comercio si lo tiene; si no, el general
    select coalesce((cm.config -> 'plan' ->> 'cuota_base_usd')::numeric, pp.cuota_base_usd) as base,
           coalesce((cm.config -> 'plan' ->> 'incluidas')::int, pp.incluidas)              as incl,
           coalesce((cm.config -> 'plan' ->> 'por_prenda_usd')::numeric, pp.por_prenda_usd) as unit,
           case when cm.config -> 'plan' ? 'techo_usd'
                then (cm.config -> 'plan' ->> 'techo_usd')::numeric else pp.techo_usd end as techo
    from public.plan_prendas pp
    left join public.comercio_modulos cm on cm.comercio_id = p_comercio and cm.modulo = 'etiqueta'
  )
  select m.desde, a.n, p.incl, greatest(a.n - p.incl, 0), p.base, p.unit, p.techo,
         round(least(p.base + greatest(a.n - p.incl, 0) * p.unit, coalesce(p.techo, 'infinity'::numeric)), 2)
  from m, a, p
$$;
revoke all on function public.uso_prendas(uuid, date) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.uso_prendas(uuid, date) to service_role;  -- el bot
  end if;
end $$;

-- Para cobrar: una fila por comercio y mes
create or replace view public.facturacion_prendas as
select co.id as comercio_id, co.nombre, co.estado, u.mes, u.altas, u.incluidas, u.extra, u.cuota_usd
from public.comercios co
join public.comercio_modulos cm on cm.comercio_id = co.id and cm.modulo = 'etiqueta'
                                and cm.config ->> 'modo' = 'prendas'
cross join lateral (
  select distinct date_trunc('month', a.created_at at time zone 'America/Argentina/Buenos_Aires')::date as mes
  from public.articulos a where a.comercio_id = co.id
) meses
cross join lateral public.uso_prendas(co.id, meses.mes) u;
revoke all on public.facturacion_prendas from anon, authenticated;
