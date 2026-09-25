# Motor de bots de WhatsApp · Andamio Digital

Un solo motor recibe todos los mensajes de WhatsApp, reconoce al comercio por el
número de quien escribe y deriva al módulo contratado (Andamio Chino, Etiqueta
Visión, Turnero, Mermas).

```
supabase/
├── migrations/20260925000000_motor_comun.sql  → tablas, reglas y bucket de fotos
├── seed_demo.sql                              → comercio de prueba con tu número
└── functions/
    ├── whatsapp-webhook/index.ts              → recibe y responde los mensajes
    ├── _shared/whatsapp.ts                    → Meta: firma, parseo, envío, fotos
    ├── _shared/router.ts                      → decide a qué módulo va cada mensaje
    ├── _shared/modulos.ts                     → respuestas de cada módulo
    └── tests/motor_test.ts                    → pruebas del router y del parseo
```

## Estado

- **Hecho:** tablas de los 4 módulos, webhook con verificación de firma, guardado
  de cada mensaje (sin duplicados), fotos y audios guardados en Storage, router
  por número con menú cuando el comercio tiene varios módulos, sesiones de 24 h,
  respuestas en español y chino.
- **Pendiente (próximas semanas del plan):** la lógica de cada módulo. Hoy cada
  módulo confirma la recepción y guarda la foto; después se agregan la lectura
  con GPT-4o, la conciliación guía-factura, la etiqueta con QR, el rescate de
  turnos y el envío a OLIVIA.

## Qué hace falta antes de desplegar

1. **Meta Business:** cuenta verificada a nombre de Juan Pablo Sanguinetti, app
   de Meta con el producto WhatsApp y un número exclusivo para el bot.
2. De Meta vas a necesitar tres datos:
   - `WA_TOKEN`: token permanente de un usuario de sistema.
   - `WA_APP_SECRET`: App secret (Configuración de la app → Básica).
   - `WA_VERIFY_TOKEN`: un texto que inventás vos (ej. una frase larga).

## Desplegar (Terminal, desde la carpeta andamio-digital)

```bash
npm i -g supabase            # una sola vez
supabase login
supabase link --project-ref qilnzidtufdxzenwcarv

supabase db push             # crea las tablas del motor

supabase secrets set WA_TOKEN=... WA_APP_SECRET=... WA_VERIFY_TOKEN=...
supabase functions deploy whatsapp-webhook --no-verify-jwt
```

La URL del webhook queda así:
`https://qilnzidtufdxzenwcarv.supabase.co/functions/v1/whatsapp-webhook`

En Meta → WhatsApp → Configuración → Webhook: pegá esa URL y el mismo
`WA_VERIFY_TOKEN`, y suscribite al campo **messages**.

## Probar

1. Editá `seed_demo.sql` con tu número y corrélo en el SQL Editor de Supabase.
2. Escribile «hola» al número del bot: tiene que responder con el menú.
3. Respondé «1» y mandá una foto: debe confirmar y la foto aparece en
   Storage → wa-media.
4. Los mensajes quedan en la tabla `mensajes`.

## Pruebas locales

```bash
deno test --allow-env supabase/functions/tests/
```

## Seguridad

- Todas las tablas tienen RLS activado y ninguna política pública: solo el
  webhook (con la service role key, que nunca va al navegador) lee y escribe.
- La única lectura pública es `caja_publica(token)`, que usa la página del QR
  de Etiqueta Visión y devuelve solo el contenido de esa caja.
- La tabla `quiz_responses` de la evaluación de vendedores no se toca.
