// Andamio Digital · webhook de WhatsApp (Supabase Edge Function)
//
// GET  → verificación del webhook de Meta (hub.challenge)
// POST → mensajes entrantes y estados de envío
//
// Secretos (supabase secrets set ...):
//   WA_TOKEN         token permanente del usuario de sistema de Meta
//   WA_APP_SECRET    "App secret" de la app de Meta (para validar la firma)
//   WA_VERIFY_TOKEN  texto que inventás y pegás también en Meta al configurar el webhook
//   WA_GRAPH_VERSION opcional, ej. v23.0
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase solo.
//
// Desplegar SIN verificación de JWT (Meta no manda JWT):
//   supabase functions deploy whatsapp-webhook --no-verify-jwt

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  descargarMedia,
  type Entrante,
  enviarBotones,
  enviarImagen,
  enviarTexto,
  extension,
  firmaValida,
  type Idioma,
  type Modulo,
  parsearWebhook,
} from "../_shared/whatsapp.ts";
import {
  acceso,
  type Acceso,
  decidir,
  type EstadoComercio,
  TEXTOS,
  textoAviso,
  textoMenu,
} from "../_shared/router.ts";
import { clienteTurnero, MANEJADORES, type SalidaModulo } from "../_shared/modulos.ts";
import { manejarPrendas } from "../_shared/prendas.ts";
import { fichaComprador, repoPrendas } from "../_shared/prendas_repo.ts";

const db: SupabaseClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // --- Verificación inicial de Meta ---------------------------------------
  if (req.method === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" &&
      url.searchParams.get("hub.verify_token") === Deno.env.get("WA_VERIFY_TOKEN");
    return ok
      ? new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 })
      : new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  // --- Firma ----------------------------------------------------------------
  const cuerpo = await req.text();
  const secreto = Deno.env.get("WA_APP_SECRET");
  if (!secreto || !(await firmaValida(cuerpo, req.headers.get("x-hub-signature-256"), secreto))) {
    return new Response("invalid signature", { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(cuerpo);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const { mensajes, estados } = parsearWebhook(body);

  // Estados de mensajes enviados (sent / delivered / read / failed)
  for (const s of estados) {
    if (!s.waMessageId) continue;
    await db.from("mensajes")
      .update({ estado: s.estado, error: s.error ?? null })
      .eq("wa_message_id", s.waMessageId);
  }

  // Mensajes entrantes. Los errores de uno no cortan a los demás, y siempre
  // respondemos 200 para que Meta no reintente en bucle.
  for (const m of mensajes) {
    try {
      await procesar(m);
    } catch (e) {
      console.error("Error procesando", m.waMessageId, e);
    }
  }
  return new Response("ok", { status: 200 });
});

async function procesar(m: Entrante) {
  // 1) Guardar el mensaje. Si Meta lo reenvía, el wamid repetido lo frena acá.
  const { data: guardado, error: errGuardar } = await db.from("mensajes")
    .insert({
      wa_message_id: m.waMessageId,
      direccion: "entrante",
      telefono: m.from,
      phone_number_id: m.phoneNumberId,
      tipo: tipoValido(m.tipo),
      texto: m.texto ?? null,
      media_id: m.mediaId ?? null,
      payload: m.raw,
    })
    .select("id")
    .single();
  if (errGuardar) {
    if (errGuardar.code === "23505") return; // duplicado: ya procesado
    throw errGuardar;
  }
  const mensajeId: string = guardado.id;

  // 2) ¿Quién escribe?
  const { data: usuario } = await db.from("usuarios")
    .select("id, comercio_id, idioma, comercios(idioma, estado, prueba_hasta, aviso_prueba_at)")
    .eq("telefono_wa", m.from).eq("activo", true).maybeSingle();

  let modulosActivos: Modulo[] = [];
  let idiomaUsuario: Idioma = "es";
  let accesoComercio: Acceso | undefined;
  if (usuario) {
    // deno-lint-ignore no-explicit-any
    const co = (usuario as any).comercios ?? {};
    idiomaUsuario = (usuario.idioma ?? co.idioma ?? "es") as Idioma;
    accesoComercio = acceso(
      (co.estado ?? "prueba") as EstadoComercio,
      new Date(co.prueba_hasta ?? Date.now()),
      new Date(),
      co.aviso_prueba_at ? new Date(co.aviso_prueba_at) : null,
    );
    const { data: mods } = await db.from("comercio_modulos")
      .select("modulo").eq("comercio_id", usuario.comercio_id).eq("activo", true);
    modulosActivos = (mods ?? []).map((x) => x.modulo as Modulo);
  }

  const { data: contactos } = usuario ? { data: [] } : await db.from("contactos")
    .select("id, comercio_id").eq("telefono_wa", m.from);

  const { data: sesion } = await db.from("sesiones")
    .select("comercio_id, modulo, paso, datos, expira_at")
    .eq("telefono_wa", m.from).maybeSingle();
  const sesionVigente = sesion && new Date(sesion.expira_at) > new Date() ? sesion : null;

  const decision = decidir({
    usuario: usuario ? { comercioId: usuario.comercio_id, idioma: idiomaUsuario } : undefined,
    modulosActivos,
    sesion: sesionVigente ?? undefined,
    comerciosComoCliente: [...new Set((contactos ?? []).map((c) => c.comercio_id as string))],
    texto: m.texto,
  });

  // 3) Guardar foto o audio en Storage (bucket privado wa-media)
  const comercioId = "comercioId" in decision ? decision.comercioId : null;
  let mediaPath: string | undefined;
  if (m.mediaId && comercioId) {
    try {
      const { bytes, mimeType } = await descargarMedia(m.mediaId);
      const mes = new Date().toISOString().slice(0, 7);
      mediaPath = `${comercioId}/${mes}/${m.waMessageId}.${extension(mimeType ?? m.mimeType)}`;
      const { error } = await db.storage.from("wa-media")
        .upload(mediaPath, bytes, { contentType: mimeType, upsert: true });
      if (error) throw error;
    } catch (e) {
      console.error("No se pudo guardar el archivo", m.mediaId, e);
      mediaPath = undefined;
    }
  }

  await db.from("mensajes").update({
    comercio_id: comercioId,
    usuario_id: usuario?.id ?? null,
    contacto_id: decision.accion === "cliente_turnero"
      ? contactos?.find((c) => c.comercio_id === decision.comercioId)?.id ?? null
      : null,
    modulo: decision.accion === "modulo" ? decision.modulo : decision.accion === "cliente_turnero" ? "turnero" : null,
    media_path: mediaPath ?? null,
  }).eq("id", mensajeId);

  // 4) Resolver la respuesta
  let salida: SalidaModulo;
  let fichaQr: SalidaModulo | null = null;
  let moduloSesion: Modulo | null = sesionVigente?.modulo ?? null;
  const bloqueado = usuario && accesoComercio && !accesoComercio.habilitado;
  if (bloqueado) {
    // Prueba vencida o servicio pausado: no se procesa el módulo
    const quiereSeguir = /^(seguir|继续)$/i.test((m.texto ?? "").trim());
    salida = {
      respuesta: quiereSeguir
        ? (idiomaUsuario === "zh" ? "谢谢！我们会尽快联系您。" : "¡Gracias! Te contactamos a la brevedad.")
        : textoAviso(accesoComercio!, idiomaUsuario) ?? TEXTOS.sinModulos[idiomaUsuario],
    };
    if (quiereSeguir) {
      await db.from("mensajes").update({ modulo: null }).eq("id", mensajeId);
      console.log("Comercio quiere seguir", usuario.comercio_id);
    }
  } else if (!usuario && (fichaQr = await fichaComprador(db, m.texto))) {
    // Un comprador escaneó el QR de una prenda
    salida = fichaQr;
  } else switch (decision.accion) {
    case "modulo": {
      moduloSesion = decision.modulo;
      const datosPrevios = decision.cambioModulo ? {} : (sesionVigente?.datos ?? {});
      if (decision.cambioModulo && sesionVigente?.paso === "elegir_modulo") {
        // Recién eligió del menú: confirmamos y esperamos su primer mensaje
        salida = decision.modulo === "etiqueta" && await modoEtiqueta(decision.comercioId) === "prendas"
          ? await manejarPrendas({
            comercioId: decision.comercioId,
            idioma: decision.idioma,
            mensaje: { ...m, tipo: "text", texto: "ayuda" },
            sesion: { paso: null, datos: {} },
          }, repoPrendas(db, decision.comercioId, { telefono: m.from, numeroBot: m.numeroBot }))
          : MANEJADORES[decision.modulo]({
          comercioId: decision.comercioId,
          idioma: decision.idioma,
          mensaje: { ...m, tipo: "text", texto: "" },
          sesion: { paso: null, datos: {} },
        }) as SalidaModulo;
      } else {
        const entrada = {
          comercioId: decision.comercioId,
          idioma: decision.idioma,
          mensaje: m,
          mediaPath,
          sesion: { paso: decision.cambioModulo ? null : sesionVigente?.paso, datos: datosPrevios },
        };
        salida = decision.modulo === "etiqueta" && await modoEtiqueta(decision.comercioId) === "prendas"
          ? await manejarPrendas(entrada, repoPrendas(db, decision.comercioId, {
            mensajeId, telefono: m.from, numeroBot: m.numeroBot,
          }))
          : await MANEJADORES[decision.modulo](entrada);
      }
      break;
    }
    case "menu":
      salida = { respuesta: textoMenu(decision.idioma, decision.opciones), paso: "elegir_modulo" };
      break;
    case "sin_modulos":
      salida = { respuesta: TEXTOS.sinModulos[decision.idioma] };
      break;
    case "cliente_turnero": {
      moduloSesion = "turnero";
      // El cliente final recibe los mensajes en el idioma del comercio
      const { data: co } = await db.from("comercios").select("idioma")
        .eq("id", decision.comercioId).maybeSingle();
      salida = clienteTurnero((co?.idioma ?? "es") as Idioma);
      break;
    }
    case "cliente_ambiguo":
      salida = { respuesta: TEXTOS.clienteAmbiguo };
      break;
    default:
      salida = { respuesta: TEXTOS.desconocido };
  }

  // Aviso de prueba (quedan pocos días / vencida): va junto con la respuesta
  const aviso = accesoComercio?.aviso ? textoAviso(accesoComercio, idiomaUsuario) : undefined;
  if (usuario && aviso) {
    if (!bloqueado) salida.respuesta = `${salida.respuesta}\n\n${aviso}`;
    await db.from("comercios").update({ aviso_prueba_at: new Date().toISOString() })
      .eq("id", usuario.comercio_id);
  }

  // 5) Actualizar la sesión (vence 24 h después del último mensaje, como la ventana de WhatsApp)
  if (comercioId) {
    await db.from("sesiones").upsert({
      telefono_wa: m.from,
      comercio_id: comercioId,
      modulo: moduloSesion,
      paso: salida.paso === undefined ? (sesionVigente?.paso ?? null) : salida.paso,
      datos: salida.datos ?? sesionVigente?.datos ?? {},
      expira_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
  }

  // 6) Responder y registrar el saliente
  let tipoSaliente = salida.imagen ? "image" : salida.botones?.length ? "interactive" : "text";
  let envio = salida.imagen
    ? await enviarImagen(m.phoneNumberId, m.from, salida.imagen, salida.respuesta)
    : salida.botones?.length
    ? await enviarBotones(m.phoneNumberId, m.from, salida.respuesta, salida.botones)
    : await enviarTexto(m.phoneNumberId, m.from, salida.respuesta);
  if (envio.error && tipoSaliente !== "text") {
    // Si la imagen o los botones fallan, que al menos llegue el texto (las opciones van numeradas)
    console.error("Envío", tipoSaliente, envio.error);
    envio = await enviarTexto(m.phoneNumberId, m.from, salida.respuesta);
    tipoSaliente = "text";
  }
  await db.from("mensajes").insert({
    wa_message_id: envio.waMessageId ?? null,
    direccion: "saliente",
    telefono: m.from,
    phone_number_id: m.phoneNumberId,
    comercio_id: comercioId,
    modulo: moduloSesion,
    tipo: tipoSaliente,
    texto: salida.respuesta,
    estado: envio.error ? "failed" : "sent",
    error: envio.error ?? null,
  });
}

/** Etiqueta Visión: «cajas» (mayoristas, por defecto) o «prendas» (ropa por kilo) */
async function modoEtiqueta(comercioId: string): Promise<"cajas" | "prendas"> {
  const { data } = await db.from("comercio_modulos").select("config")
    .eq("comercio_id", comercioId).eq("modulo", "etiqueta").maybeSingle();
  return data?.config?.modo === "prendas" ? "prendas" : "cajas";
}

const TIPOS = new Set([
  "text", "image", "audio", "document", "interactive", "button",
  "template", "location", "sticker", "video", "reaction",
]);
const tipoValido = (t: string) => (TIPOS.has(t) ? t : "unsupported");
