# Motor de bots de WhatsApp · Andamio Digital

Un solo motor recibe todos los mensajes de WhatsApp, reconoce al comercio por el
número de quien escribe y deriva al módulo contratado (Andamio Chino, Etiqueta
Visión, Turnero, Mermas).

```
supabase/
├── migrations/20260925000000_motor_comun.sql  → tablas, reglas y bucket de fotos
├── migrations/20260925010000_prueba_7_dias.sql → prueba gratis de 7 días y cupo de 10 pilotos
├── seed_demo.sql                              → comercio de prueba con tu número
└── functions/
    ├── whatsapp-webhook/index.ts              → recibe y responde los mensajes
    ├── _shared/whatsapp.ts                    → Meta: firma, parseo, envío, fotos
    ├── _shared/router.ts                      → decide a qué módulo va cada mensaje
    ├── _shared/modulos.ts                     → respuestas de cada módulo
    └── tests/motor_test.ts                    → pruebas del router y del parseo
```

## Costo cero hasta los 10 primeros comercios

Decisión: Andamio no paga nada hasta tener 10 comercios; recién ahí se compran
licencias con lo que se recaude.

| Pieza | Plan | Costo |
|---|---|---|
| WhatsApp (Meta) | Respuestas dentro de las 24 h desde que escribe el comercio | Gratis |
| Turnero: recordatorios y rescate | Plantillas fuera de la ventana de 24 h | Centavos por mensaje, los absorbe Andamio |
| Lectura de fotos y audios | Cloudflare Workers AI (10.000 neuronas/día gratis) | Gratis; GPT-4o solo cuando haya ingresos |
| Base, webhook y fotos | Supabase Free (500 MB, 1 GB de archivos, 500.000 ejecuciones/mes) | Gratis |
| Sitio | Netlify o Cloudflare Pages (Vercel Hobby no permite uso comercial) | Gratis |
| Línea del bot | Chip prepago argentino | Único gasto |

## Prueba gratis de 7 días

- Todo comercio nuevo entra en estado `prueba` por 7 días.
- Cuando le quedan 2 días, el bot lo avisa junto con la respuesta (una sola vez).
- Al vencer, el bot deja de procesar y avisa; si responde «seguir», queda registrado.
- Para habilitarlo: cambiar `estado` a `piloto` (bonificado, primeros 10; ver la
  vista `cupo_pilotos`) o a `activo` (pago).

## Estado

- **Hecho:** tablas de los 4 módulos, webhook con verificación de firma, guardado
  de cada mensaje (sin duplicados), fotos y audios guardados en Storage, router
  por número con menú cuando el comercio tiene varios módulos, sesiones de 24 h,
  respuestas en español y chino.
- **Hecho (26/9):** Etiqueta Visión modo «prenda por prenda» completo (ver abajo).
- **Pendiente (próximas semanas del plan):** el resto de la lógica. Andamio Chino,
  Etiqueta en modo cajas, Turnero y Mermas todavía confirman la recepción y guardan
  la foto; después se agregan la lectura con IA de guías y facturas, la conciliación,
  la etiqueta con QR, el rescate de turnos y el envío a OLIVIA.

## Etiqueta Visión · prenda por prenda (ropa por kilo)

Se activa por comercio, en el SQL Editor:

```sql
update comercio_modulos
   set config = '{"modo": "prendas", "precio_kg": 12000}'
 where comercio_id = '<id del comercio>' and modulo = 'etiqueta';
```

(El precio por kilo también lo puede cargar el dueño por WhatsApp: «precio 12000».)

| El comercio manda | El bot hace |
|---|---|
| Foto de la prenda + «0,85» (o «850 g», «1.7斤») | Alta: código de 5 caracteres para la etiqueta, precio = peso × kilo |
| Foto sola | Intenta leer el código de la etiqueta (IA). Si es de una prenda en stock → venta. Si no, pregunta el peso o el código |
| «vendí K7M3Q» / 「卖出 K7M3Q」 | Venta: sale del stock y del catálogo |
| «deshacer K7M3Q» / 「撤销 K7M3Q」 | Vuelve al stock (sirve para errores y para liberar reservas) |
| «baja», «reservar» + código | Baja o reserva (no se muestra en el catálogo) |
| «stock» / 「库存」 | Cantidad, kilos y valor en stock |
| «catálogo» / 「目录」 | Link al catálogo público (necesita `CATALOGO_URL`, `slug` y `catalogo_publico = true`) |

Las fotos de alta se copian al bucket público `catalogo`; las de venta quedan en
`wa-media` como respaldo.

**Lectura automática del código (opcional):** con `CF_ACCOUNT_ID` y `CF_AI_TOKEN`
el bot usa Workers AI (plan gratis). Sin esas variables, simplemente pide el código.
Los modelos Llama de Meta piden aceptar la licencia una vez:

```bash
curl https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai/run/@cf/meta/llama-3.2-11b-vision-instruct \
  -H "Authorization: Bearer $CF_AI_TOKEN" -d '{"prompt":"agree"}'
```

## Qué hace falta antes de desplegar

1. **Meta Business:** cuenta verificada a nombre de Juan Pablo Sanguinetti, app
   de Meta con el producto WhatsApp y un número exclusivo para el bot.
2. De Meta vas a necesitar tres datos:
   - `WA_TOKEN`: token permanente de un usuario de sistema.
   - `WA_APP_SECRET`: App secret (Configuración de la app → Básica).
   - `WA_VERIFY_TOKEN`: un texto que inventás vos (ej. una frase larga).
3. Para la lectura de fotos (cuando se active): una cuenta gratis de Cloudflare
   con `CF_ACCOUNT_ID` y un token `CF_AI_TOKEN` con permiso de Workers AI.

## Desplegar (Terminal, desde la carpeta andamio-digital)

```bash
npm i -g supabase            # una sola vez
supabase login
supabase link --project-ref qilnzidtufdxzenwcarv

supabase db push             # crea las tablas del motor

supabase secrets set WA_TOKEN=... WA_APP_SECRET=... WA_VERIFY_TOKEN=...
# opcionales: CF_ACCOUNT_ID=... CF_AI_TOKEN=... CATALOGO_URL=https://<sitio>/catalogo.html
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
