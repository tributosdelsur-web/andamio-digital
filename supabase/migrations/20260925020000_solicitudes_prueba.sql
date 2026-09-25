-- ============================================================================
-- Andamio Digital · solicitudes de prueba gratis desde el sitio
--
-- El formulario «Probalo 7 días gratis» del sitio guarda acá cada pedido.
-- La clave pública (publishable) del sitio SOLO puede insertar: no puede leer,
-- así nadie ve los datos de otros comercios. Las solicitudes se leen desde el
-- panel de Supabase (Table Editor → solicitudes_prueba).
-- ============================================================================

create table if not exists public.solicitudes_prueba (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null check (char_length(nombre) between 2 and 120),
  comercio    text not null check (char_length(comercio) between 2 and 160),
  rubro       text check (char_length(rubro) <= 60),
  piloto      text check (piloto in ('chino', 'etiqueta', 'turnero', 'mermas', 'no_se')),
  whatsapp    text not null check (whatsapp ~ '^[0-9 +()-]{8,25}$'),
  idioma      text not null default 'es' check (idioma in ('es', 'zh')),
  mensaje     text check (char_length(mensaje) <= 1000),
  origen      text default 'sitio',
  estado      text not null default 'nueva'
                check (estado in ('nueva', 'contactada', 'en_prueba', 'descartada')),
  created_at  timestamptz not null default now()
);

alter table public.solicitudes_prueba enable row level security;

drop policy if exists "El sitio puede enviar solicitudes" on public.solicitudes_prueba;
create policy "El sitio puede enviar solicitudes"
  on public.solicitudes_prueba
  for insert
  to anon
  with check (estado = 'nueva');
