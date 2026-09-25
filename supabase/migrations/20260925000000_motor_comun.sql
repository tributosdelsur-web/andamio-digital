-- ============================================================================
-- Andamio Digital · Motor común de bots de WhatsApp
-- Proyecto Supabase: Andamio-Digital
--
-- Un solo motor recibe todos los mensajes (webhook de Meta Cloud API),
-- identifica al comercio por el número de WhatsApp de quien escribe y deriva
-- al módulo contratado: chino, etiqueta, turnero o mermas.
--
-- Seguridad: todas las tablas tienen RLS activado y SIN políticas para anon.
-- Solo las Edge Functions (con la service role key) leen y escriben. La única
-- lectura pública es la página de una caja de Etiqueta Visión, vía la función
-- caja_publica(token), que devuelve solo lo necesario.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Utilidades
-- ---------------------------------------------------------------------------

-- Teléfonos siempre como solo dígitos, formato internacional sin "+"
-- (ej. Argentina móvil: 5491112345678). Es la llave que une Andamio y OLIVIA.
create or replace function public.solo_digitos(t text)
returns text language sql immutable as $$
  select nullif(regexp_replace(coalesce(t, ''), '\D', '', 'g'), '')
$$;

create or replace function public.tocar_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Núcleo: comercios, módulos, personas
-- ---------------------------------------------------------------------------

create table public.comercios (
  id               uuid primary key default gen_random_uuid(),
  nombre           text not null,
  rubro            text,
  telefono_wa      text not null unique check (telefono_wa ~ '^\d{8,15}$'),
  idioma           text not null default 'es' check (idioma in ('es', 'zh')),
  estado           text not null default 'piloto'
                     check (estado in ('piloto', 'activo', 'pausado', 'baja')),
  -- Consentimiento para enviar datos de mermas orgánicas a OLIVIA / Metamorfosis
  consiente_olivia boolean not null default false,
  consiente_olivia_at timestamptz,
  notas            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger comercios_updated before update on public.comercios
  for each row execute function public.tocar_updated_at();

create table public.comercio_modulos (
  comercio_id uuid not null references public.comercios(id) on delete cascade,
  modulo      text not null check (modulo in ('chino', 'etiqueta', 'turnero', 'mermas')),
  activo      boolean not null default true,
  -- Configuración propia del módulo: margen objetivo (chino), horarios y
  -- duración de turno (turnero), costos por defecto (mermas), etc.
  config      jsonb not null default '{}'::jsonb,
  precio_setup_usd numeric(10,2),
  precio_mes_usd   numeric(10,2),
  created_at  timestamptz not null default now(),
  primary key (comercio_id, modulo)
);

-- Personas del comercio que le escriben al bot (dueño y empleados).
-- Un teléfono pertenece a un solo comercio.
create table public.usuarios (
  id          uuid primary key default gen_random_uuid(),
  comercio_id uuid not null references public.comercios(id) on delete cascade,
  telefono_wa text not null unique check (telefono_wa ~ '^\d{8,15}$'),
  nombre      text,
  rol         text not null default 'empleado' check (rol in ('dueno', 'empleado')),
  idioma      text check (idioma in ('es', 'zh')),
  activo      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index usuarios_comercio_idx on public.usuarios (comercio_id);

-- Clientes finales de un comercio (Turnero). Solo nombre y teléfono:
-- nada clínico, aunque el comercio sea un consultorio.
create table public.contactos (
  id          uuid primary key default gen_random_uuid(),
  comercio_id uuid not null references public.comercios(id) on delete cascade,
  telefono_wa text not null check (telefono_wa ~ '^\d{8,15}$'),
  nombre      text,
  -- Opt-in explícito para recibir plantillas (recordatorios, huecos liberados)
  opt_in      boolean not null default false,
  opt_in_at   timestamptz,
  created_at  timestamptz not null default now(),
  unique (comercio_id, telefono_wa)
);
create index contactos_telefono_idx on public.contactos (telefono_wa);

-- ---------------------------------------------------------------------------
-- Mensajería
-- ---------------------------------------------------------------------------

create table public.mensajes (
  id            uuid primary key default gen_random_uuid(),
  -- id de Meta (wamid). Único: si Meta reintenta el webhook, no se duplica.
  wa_message_id text unique,
  direccion     text not null check (direccion in ('entrante', 'saliente')),
  telefono      text not null,          -- el otro extremo (quien escribe o recibe)
  phone_number_id text,                 -- número del bot en Meta
  comercio_id   uuid references public.comercios(id) on delete set null,
  usuario_id    uuid references public.usuarios(id) on delete set null,
  contacto_id   uuid references public.contactos(id) on delete set null,
  modulo        text check (modulo in ('chino', 'etiqueta', 'turnero', 'mermas')),
  tipo          text not null default 'text'
                  check (tipo in ('text', 'image', 'audio', 'document', 'interactive',
                                  'button', 'template', 'location', 'sticker', 'video',
                                  'reaction', 'unsupported')),
  texto         text,
  media_id      text,                   -- id del archivo en Meta
  media_path    text,                   -- ruta en Storage (bucket wa-media)
  estado        text,                   -- saliente: sent / delivered / read / failed
  error         jsonb,
  payload       jsonb,                  -- mensaje crudo de Meta, para auditoría
  created_at    timestamptz not null default now()
);
create index mensajes_comercio_idx on public.mensajes (comercio_id, created_at desc);
create index mensajes_telefono_idx on public.mensajes (telefono, created_at desc);

-- Estado de la conversación con cada teléfono: en qué módulo y paso está,
-- y los datos a confirmar (ej. la guía leída esperando "Sí").
create table public.sesiones (
  telefono_wa text primary key,
  comercio_id uuid references public.comercios(id) on delete cascade,
  modulo      text check (modulo in ('chino', 'etiqueta', 'turnero', 'mermas')),
  paso        text,
  datos       jsonb not null default '{}'::jsonb,
  expira_at   timestamptz not null default now() + interval '24 hours',
  updated_at  timestamptz not null default now()
);
create trigger sesiones_updated before update on public.sesiones
  for each row execute function public.tocar_updated_at();

-- ---------------------------------------------------------------------------
-- Módulo 1 · Andamio Chino (cierre 360: guía → factura → precio de góndola)
-- ---------------------------------------------------------------------------

create table public.proveedores (
  id          uuid primary key default gen_random_uuid(),
  comercio_id uuid not null references public.comercios(id) on delete cascade,
  nombre      text not null,
  cuit        text,
  created_at  timestamptz not null default now(),
  unique (comercio_id, nombre)
);

create table public.productos (
  id               uuid primary key default gen_random_uuid(),
  comercio_id      uuid not null references public.comercios(id) on delete cascade,
  nombre           text not null,
  unidad           text,
  costo_actual     numeric(14,2),
  costo_anterior   numeric(14,2),
  -- Margen objetivo del producto; si es null se usa el del módulo (config.margen_objetivo)
  margen_objetivo  numeric(5,4) check (margen_objetivo >= 0 and margen_objetivo < 1),
  precio_gondola   numeric(14,2),
  updated_at       timestamptz not null default now(),
  unique (comercio_id, nombre)
);
create trigger productos_updated before update on public.productos
  for each row execute function public.tocar_updated_at();

create table public.guias (
  id            uuid primary key default gen_random_uuid(),
  comercio_id   uuid not null references public.comercios(id) on delete cascade,
  proveedor_id  uuid references public.proveedores(id) on delete set null,
  numero        text,
  fecha         date,
  total         numeric(14,2),
  pagado_efectivo numeric(14,2),
  estado        text not null default 'borrador'
                  check (estado in ('borrador', 'pendiente_factura', 'conciliada', 'con_diferencias', 'anulada')),
  foto_path     text,
  extraccion    jsonb,                  -- lo que leyó la IA, tal cual
  confirmada_at timestamptz,            -- cuando el comercio respondió "Sí"
  mensaje_id    uuid references public.mensajes(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index guias_pendientes_idx on public.guias (comercio_id, proveedor_id)
  where estado = 'pendiente_factura';

create table public.guia_items (
  id           uuid primary key default gen_random_uuid(),
  guia_id      uuid not null references public.guias(id) on delete cascade,
  producto_id  uuid references public.productos(id) on delete set null,
  descripcion  text not null,
  cantidad     numeric(14,3),
  unidad       text,
  precio_unit  numeric(14,2),
  subtotal     numeric(14,2)
);
create index guia_items_guia_idx on public.guia_items (guia_id);

create table public.facturas (
  id            uuid primary key default gen_random_uuid(),
  comercio_id   uuid not null references public.comercios(id) on delete cascade,
  proveedor_id  uuid references public.proveedores(id) on delete set null,
  tipo          text,                   -- A, B, C
  numero        text,
  fecha         date,
  total         numeric(14,2),
  foto_path     text,
  extraccion    jsonb,
  diferencias   jsonb,                  -- resultado de la conciliación contra las guías
  estado        text not null default 'borrador'
                  check (estado in ('borrador', 'conciliada', 'con_diferencias', 'anulada')),
  mensaje_id    uuid references public.mensajes(id) on delete set null,
  created_at    timestamptz not null default now()
);

-- Una factura puede agrupar varias guías
create table public.factura_guias (
  factura_id uuid not null references public.facturas(id) on delete cascade,
  guia_id    uuid not null references public.guias(id) on delete cascade,
  primary key (factura_id, guia_id)
);

-- precio = costo ÷ (1 − margen objetivo)
create or replace function public.precio_sugerido(costo numeric, margen numeric)
returns numeric language sql immutable as $$
  select case
    when costo is null or margen is null or margen < 0 or margen >= 1 then null
    else round(costo / (1 - margen), 2)
  end
$$;

-- ---------------------------------------------------------------------------
-- Módulo 2 · Etiqueta Visión (cajas con QR)
-- ---------------------------------------------------------------------------

create table public.cajas (
  id           uuid primary key default gen_random_uuid(),
  comercio_id  uuid not null references public.comercios(id) on delete cascade,
  codigo       text not null,           -- visible en la etiqueta, ej. C-000123
  -- Token del QR: la página pública se abre con este token, no con el id
  token        text not null unique default encode(gen_random_bytes(12), 'hex'),
  resumen      text,
  ubicacion    text,
  foto_path    text,
  estado       text not null default 'borrador'
                 check (estado in ('borrador', 'etiquetada', 'vendida', 'anulada')),
  etiqueta_pdf_path text,
  created_at   timestamptz not null default now(),
  unique (comercio_id, codigo)
);

create table public.caja_items (
  id          uuid primary key default gen_random_uuid(),
  caja_id     uuid not null references public.cajas(id) on delete cascade,
  descripcion text not null,
  talle       text,
  color       text,
  cantidad    integer not null default 1 check (cantidad > 0)
);
create index caja_items_caja_idx on public.caja_items (caja_id);

-- Lectura pública de una caja por su token (lo que abre el QR).
-- security definer: salta RLS pero devuelve solo campos no sensibles.
create or replace function public.caja_publica(p_token text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'codigo',    c.codigo,
    'comercio',  co.nombre,
    'resumen',   c.resumen,
    'ubicacion', c.ubicacion,
    'estado',    c.estado,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'descripcion', i.descripcion, 'talle', i.talle,
               'color', i.color, 'cantidad', i.cantidad) order by i.descripcion)
      from public.caja_items i where i.caja_id = c.id), '[]'::jsonb)
  )
  from public.cajas c
  join public.comercios co on co.id = c.comercio_id
  where c.token = p_token and c.estado <> 'anulada'
$$;
revoke all on function public.caja_publica(text) from public;
grant execute on function public.caja_publica(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Módulo 3 · Turnero con Rescate
-- ---------------------------------------------------------------------------

create table public.turnos (
  id           uuid primary key default gen_random_uuid(),
  comercio_id  uuid not null references public.comercios(id) on delete cascade,
  contacto_id  uuid references public.contactos(id) on delete set null,
  servicio     text,
  inicio       timestamptz not null,
  fin          timestamptz not null,
  estado       text not null default 'reservado'
                 check (estado in ('libre', 'reservado', 'confirmado', 'cancelado',
                                   'rescatado', 'completado', 'ausente')),
  recordatorio_enviado_at timestamptz,
  cancelado_at timestamptz,
  created_at   timestamptz not null default now(),
  check (fin > inicio)
);
create index turnos_agenda_idx on public.turnos (comercio_id, inicio);

-- Un mismo horario no puede tener dos turnos activos en el mismo comercio
create unique index turnos_sin_doble_reserva on public.turnos (comercio_id, inicio)
  where estado in ('reservado', 'confirmado', 'rescatado');

create table public.lista_espera (
  id           uuid primary key default gen_random_uuid(),
  comercio_id  uuid not null references public.comercios(id) on delete cascade,
  contacto_id  uuid not null references public.contactos(id) on delete cascade,
  -- Ventana en la que la persona puede venir
  desde        timestamptz,
  hasta        timestamptz,
  estado       text not null default 'esperando'
                 check (estado in ('esperando', 'ofrecido', 'aceptado', 'baja')),
  created_at   timestamptz not null default now()
);
create index lista_espera_orden_idx on public.lista_espera (comercio_id, created_at)
  where estado = 'esperando';

-- Rescate secuencial: una oferta por vez, con vencimiento (ej. 15 minutos)
create table public.ofertas_hueco (
  id              uuid primary key default gen_random_uuid(),
  turno_id        uuid not null references public.turnos(id) on delete cascade,
  lista_espera_id uuid not null references public.lista_espera(id) on delete cascade,
  enviada_at      timestamptz not null default now(),
  expira_at       timestamptz not null,
  estado          text not null default 'pendiente'
                    check (estado in ('pendiente', 'aceptada', 'rechazada', 'vencida')),
  mensaje_id      uuid references public.mensajes(id) on delete set null
);
-- Solo una oferta pendiente por hueco a la vez
create unique index ofertas_una_pendiente on public.ofertas_hueco (turno_id)
  where estado = 'pendiente';

-- ---------------------------------------------------------------------------
-- Módulo 4 · Mermas (vinculado a OLIVIA / Metamorfosis)
-- Regla: el registro de merma es dato de gestión, NO dato certificable.
-- Solo cuenta para dMRV lo que se entrega y se verifica en planta (en OLIVIA).
-- ---------------------------------------------------------------------------

create table public.mermas (
  id            uuid primary key default gen_random_uuid(),
  comercio_id   uuid not null references public.comercios(id) on delete cascade,
  producto_id   uuid references public.productos(id) on delete set null,
  producto      text not null,
  kg            numeric(10,3) not null check (kg > 0),
  costo_kg      numeric(14,2),
  perdida       numeric(14,2) generated always as (round(kg * costo_kg, 2)) stored,
  es_organico   boolean not null default true,
  fuente        text not null default 'foto' check (fuente in ('foto', 'audio', 'texto')),
  foto_path     text,
  fecha         date not null default current_date,
  confirmada_at timestamptz,
  mensaje_id    uuid references public.mensajes(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index mermas_comercio_fecha_idx on public.mermas (comercio_id, fecha);

-- Entregas de orgánicos a un punto o planta: esto es lo que se envía a OLIVIA
create table public.entregas_olivia (
  id                uuid primary key default gen_random_uuid(),
  comercio_id       uuid not null references public.comercios(id) on delete cascade,
  kg_estimados      numeric(10,3) not null check (kg_estimados > 0),
  foto_path         text,
  punto_entrega     text,
  enviada_at        timestamptz,
  olivia_residuo_id text,                -- id que devuelve OLIVIA
  estado            text not null default 'pendiente'
                      check (estado in ('pendiente', 'enviada', 'error')),
  error             text,
  created_at        timestamptz not null default now()
);

-- Reporte semanal: total perdido y productos que más se tiran
create or replace view public.mermas_semana as
select
  comercio_id,
  date_trunc('week', fecha)::date as semana,
  producto,
  sum(kg)      as kg,
  sum(perdida) as perdida
from public.mermas
group by comercio_id, date_trunc('week', fecha), producto;

-- ---------------------------------------------------------------------------
-- RLS: activado en todo, sin políticas → solo service role (Edge Functions)
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'comercios', 'comercio_modulos', 'usuarios', 'contactos', 'mensajes', 'sesiones',
    'proveedores', 'productos', 'guias', 'guia_items', 'facturas', 'factura_guias',
    'cajas', 'caja_items', 'turnos', 'lista_espera', 'ofertas_hueco',
    'mermas', 'entregas_olivia'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- La vista hereda permisos: que no la lea anon
revoke all on public.mermas_semana from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Storage: bucket privado para fotos y audios de WhatsApp
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('wa-media', 'wa-media', false)
on conflict (id) do nothing;
