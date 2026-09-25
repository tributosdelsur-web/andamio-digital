-- ============================================================================
-- Andamio Digital · Etiqueta Visión, modo «prenda por prenda» con catálogo
--
-- Pensado para tiendas que venden por peso (ej. ropa por kilo):
--   1. Al pesar y etiquetar: foto → artículo con peso, precio por kilo y un
--      código corto que va en la etiqueta. Queda «en_stock» y sale en el catálogo.
--   2. Catálogo público (español y chino) con lo que hay en stock; el comprador
--      pide por WhatsApp al número del comercio.
--   3. Al vender: foto de la etiqueta → el bot lee el código → «vendido».
--   Lo que está en stock en el catálogo es el inventario físico.
--
-- El modo se elige por comercio en comercio_modulos.config del módulo
-- 'etiqueta': {"modo": "cajas"} (mayoristas) o {"modo": "prendas", "precio_kg": 12000}.
-- ============================================================================

-- Catálogo público del comercio: dirección corta y si está visible
alter table public.comercios
  add column if not exists slug text unique
    check (slug ~ '^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$'),
  add column if not exists catalogo_publico boolean not null default false;

-- Códigos cortos y fáciles de leer en una foto (sin 0/O, 1/I/L)
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
    exit when not exists (select 1 from public.articulos a where a.comercio_id = p_comercio and a.codigo = c);
    intentos := intentos + 1;
    if intentos > 20 then raise exception 'No se pudo generar un código único'; end if;
  end loop;
  return c;
end $$;

create table if not exists public.articulos (
  id            uuid primary key default gen_random_uuid(),
  comercio_id   uuid not null references public.comercios(id) on delete cascade,
  codigo        text not null,                       -- va impreso en la etiqueta
  descripcion   text,
  categoria     text,                                -- ej. camperas, jeans, lote mixto
  talle         text,
  color         text,
  peso_kg       numeric(8,3) check (peso_kg > 0),
  precio_kg     numeric(14,2) check (precio_kg >= 0),
  -- Precio final: el fijado a mano, o peso × precio por kilo
  precio_manual numeric(14,2) check (precio_manual >= 0),
  precio        numeric(14,2) generated always as (
                  coalesce(precio_manual, round(peso_kg * precio_kg, 2))) stored,
  foto_path     text,                                -- bucket público «catalogo»
  estado        text not null default 'en_stock'
                  check (estado in ('en_stock', 'reservado', 'vendido', 'baja')),
  vendido_at    timestamptz,
  venta_foto_path text,                              -- foto de la etiqueta al vender (respaldo)
  alta_mensaje_id  uuid references public.mensajes(id) on delete set null,
  venta_mensaje_id uuid references public.mensajes(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (comercio_id, codigo)
);
create index if not exists articulos_stock_idx on public.articulos (comercio_id, created_at desc)
  where estado = 'en_stock';

-- Asigna el código automáticamente si no viene
create or replace function public.articulos_codigo_default()
returns trigger language plpgsql as $$
begin
  if new.codigo is null or new.codigo = '' then
    new.codigo := public.nuevo_codigo_articulo(new.comercio_id);
  end if;
  new.codigo := upper(new.codigo);
  if new.estado = 'vendido' and new.vendido_at is null then
    new.vendido_at := now();
  end if;
  return new;
end $$;

drop trigger if exists articulos_codigo on public.articulos;
create trigger articulos_codigo before insert or update on public.articulos
  for each row execute function public.articulos_codigo_default();

alter table public.articulos enable row level security;

-- Catálogo público: solo lo que está en stock y solo si el comercio lo habilitó.
-- Devuelve el WhatsApp del comercio para que el comprador haga el pedido.
create or replace function public.catalogo_publico(p_slug text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'comercio', co.nombre,
    'idioma',   co.idioma,
    'whatsapp', co.telefono_wa,
    'articulos', coalesce((
      select jsonb_agg(jsonb_build_object(
               'codigo', a.codigo, 'descripcion', a.descripcion, 'categoria', a.categoria,
               'talle', a.talle, 'color', a.color, 'peso_kg', a.peso_kg,
               'precio', a.precio, 'foto_path', a.foto_path)
             order by a.created_at desc)
      from public.articulos a
      where a.comercio_id = co.id and a.estado = 'en_stock'), '[]'::jsonb)
  )
  from public.comercios co
  where co.slug = lower(p_slug)
    and co.catalogo_publico
    and co.estado in ('prueba', 'piloto', 'activo')
$$;
revoke all on function public.catalogo_publico(text) from public;
grant execute on function public.catalogo_publico(text) to anon, authenticated;

-- Resumen de inventario para el dueño (lo lee el bot o el panel)
create or replace view public.inventario_prendas as
select comercio_id,
       count(*) filter (where estado = 'en_stock')             as en_stock,
       coalesce(sum(peso_kg) filter (where estado = 'en_stock'), 0) as kg_en_stock,
       coalesce(sum(precio)  filter (where estado = 'en_stock'), 0) as valor_en_stock,
       count(*) filter (where estado = 'vendido' and vendido_at >= date_trunc('week', now())) as vendidos_semana,
       coalesce(sum(precio)  filter (where estado = 'vendido' and vendido_at >= date_trunc('week', now())), 0) as ventas_semana
from public.articulos
group by comercio_id;
revoke all on public.inventario_prendas from anon, authenticated;

-- Fotos del catálogo: bucket público (solo fotos de prendas, nunca documentos)
insert into storage.buckets (id, name, public)
values ('catalogo', 'catalogo', true)
on conflict (id) do nothing;
