-- ============================================================================
-- Andamio Digital · Etiqueta Visión, prenda por prenda: QR, entregas y tramos
--
--   * Cada prenda lleva una etiqueta con QR que abre WhatsApp con su código.
--     Cada escaneo avanza la operación: stock → reserva (retiro o envío) →
--     en camino → entregada. Todo queda en articulo_eventos (quién y cuándo).
--   * Los envíos los hace el comercio con la empresa que ya usa (PedidosYa,
--     Uber, moto propia…); Andamio solo registra el estado y una nota.
--   * Cuota por tramos según prendas dadas de alta en el mes (tramos_prendas).
-- ============================================================================

-- Estados nuevos: en_camino y entregado
alter table public.articulos drop constraint if exists articulos_estado_check;
alter table public.articulos add constraint articulos_estado_check
  check (estado in ('en_stock', 'reservado', 'en_camino', 'vendido', 'entregado', 'baja'));

alter table public.articulos
  add column if not exists entrega text check (entrega in ('local', 'retiro', 'envio')),
  add column if not exists envio_nota text,          -- empresa, link de seguimiento, zona
  add column if not exists etiqueta_path text;       -- PNG de la etiqueta con QR (bucket catalogo)

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
                ('alta', 'en_stock', 'reservado', 'en_camino', 'vendido', 'entregado', 'baja')),
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
-- Cuota por tramos (solo este modo). Editable desde el SQL Editor.
-- ---------------------------------------------------------------------------
create table if not exists public.tramos_prendas (
  orden      int primary key,
  nombre_es  text not null,
  nombre_zh  text not null,
  hasta      int check (hasta > 0),                   -- null = sin tope (último tramo)
  cuota_usd  numeric(10,2) not null check (cuota_usd >= 0)
);
insert into public.tramos_prendas (orden, nombre_es, nombre_zh, hasta, cuota_usd) values
  (1, 'Chico',   '小', 300,  37),
  (2, 'Mediano', '中', 1000, 65),
  (3, 'Grande',  '大', null, 95)
on conflict (orden) do nothing;
alter table public.tramos_prendas enable row level security;

-- Prendas dadas de alta en el mes (hora de Buenos Aires) y tramo que corresponde
create or replace function public.uso_prendas(p_comercio uuid, p_mes date default null)
returns table (mes date, altas bigint, orden int, nombre_es text, nombre_zh text, hasta int, cuota_usd numeric)
language sql stable security definer set search_path = public as $$
  with m as (
    select coalesce(p_mes, (now() at time zone 'America/Argentina/Buenos_Aires')::date) as d
  ), r as (
    select date_trunc('month', m.d)::date as desde,
           (date_trunc('month', m.d) + interval '1 month')::date as hasta_fecha
    from m
  ), a as (
    select count(*) as n from public.articulos x, r
    where x.comercio_id = p_comercio
      and (x.created_at at time zone 'America/Argentina/Buenos_Aires') >= r.desde
      and (x.created_at at time zone 'America/Argentina/Buenos_Aires') <  r.hasta_fecha
  )
  select r.desde, a.n, t.orden, t.nombre_es, t.nombre_zh, t.hasta, t.cuota_usd
  from r, a, lateral (
    select * from public.tramos_prendas tp
    where tp.hasta is null or tp.hasta >= a.n
    order by tp.orden limit 1
  ) t
$$;
revoke all on function public.uso_prendas(uuid, date) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.uso_prendas(uuid, date) to service_role;  -- el bot
  end if;
end $$;

-- Para cobrar: una fila por comercio y mes
create or replace view public.facturacion_prendas as
select co.id as comercio_id, co.nombre, co.estado, u.mes, u.altas, u.nombre_es as tramo, u.cuota_usd
from public.comercios co
join public.comercio_modulos cm on cm.comercio_id = co.id and cm.modulo = 'etiqueta'
                                and cm.config ->> 'modo' = 'prendas'
cross join lateral (
  select distinct date_trunc('month', a.created_at at time zone 'America/Argentina/Buenos_Aires')::date as mes
  from public.articulos a where a.comercio_id = co.id
) meses
cross join lateral public.uso_prendas(co.id, meses.mes) u;
revoke all on public.facturacion_prendas from anon, authenticated;
