// Andamio Digital · utilidades de WhatsApp Cloud API (Meta)
// Sin dependencias externas: solo fetch y Web Crypto (Deno / Supabase Edge).

export const GRAPH_VERSION = Deno.env.get("WA_GRAPH_VERSION") ?? "v23.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

export type Modulo = "chino" | "etiqueta" | "turnero" | "mermas";
export type Idioma = "es" | "zh";

/** Mensaje entrante ya normalizado desde el payload de Meta. */
export interface Entrante {
  waMessageId: string;
  phoneNumberId: string; // id del número del bot en Meta
  numeroBot?: string; // número visible del bot, solo dígitos (para los QR)
  from: string; // teléfono de quien escribe, solo dígitos
  nombrePerfil?: string;
  tipo: string; // text, image, audio, document, interactive, button, ...
  texto?: string; // texto, caption o título del botón/lista elegido
  mediaId?: string;
  mimeType?: string;
  timestamp: number; // segundos
  raw: unknown;
}

export interface EstadoSaliente {
  waMessageId: string;
  estado: string; // sent | delivered | read | failed
  error?: unknown;
}

export const soloDigitos = (t: string | undefined | null) =>
  (t ?? "").replace(/\D/g, "");

// ---------------------------------------------------------------------------
// Firma del webhook (X-Hub-Signature-256 = HMAC-SHA256 del cuerpo crudo)
// ---------------------------------------------------------------------------
export async function firmaValida(
  cuerpo: string,
  header: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(cuerpo)),
  );
  const esperado = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  const recibido = header.slice("sha256=".length).toLowerCase();
  if (recibido.length !== esperado.length) return false;
  let diff = 0;
  for (let i = 0; i < esperado.length; i++) {
    diff |= esperado.charCodeAt(i) ^ recibido.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Parseo del payload de Meta
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
export function parsearWebhook(body: any): {
  mensajes: Entrante[];
  estados: EstadoSaliente[];
} {
  const mensajes: Entrante[] = [];
  const estados: EstadoSaliente[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const v = change?.value ?? {};
      const phoneNumberId = v?.metadata?.phone_number_id ?? "";
      const numeroBot = soloDigitos(v?.metadata?.display_phone_number) || undefined;
      const perfiles = new Map<string, string>();
      for (const c of v?.contacts ?? []) {
        if (c?.wa_id) perfiles.set(soloDigitos(c.wa_id), c?.profile?.name);
      }
      for (const m of v?.messages ?? []) {
        const from = soloDigitos(m?.from);
        const tipo: string = m?.type ?? "unsupported";
        let texto: string | undefined;
        let mediaId: string | undefined;
        let mimeType: string | undefined;
        switch (tipo) {
          case "text":
            texto = m.text?.body;
            break;
          case "image":
          case "audio":
          case "document":
          case "video":
          case "sticker":
            mediaId = m[tipo]?.id;
            mimeType = m[tipo]?.mime_type;
            texto = m[tipo]?.caption;
            break;
          case "interactive":
            texto = m.interactive?.button_reply?.id ??
              m.interactive?.list_reply?.id ??
              m.interactive?.button_reply?.title ??
              m.interactive?.list_reply?.title;
            break;
          case "button":
            texto = m.button?.payload ?? m.button?.text;
            break;
        }
        mensajes.push({
          waMessageId: m?.id,
          phoneNumberId,
          numeroBot,
          from,
          nombrePerfil: perfiles.get(from),
          tipo,
          texto,
          mediaId,
          mimeType,
          timestamp: Number(m?.timestamp ?? 0),
          raw: m,
        });
      }
      for (const s of v?.statuses ?? []) {
        estados.push({ waMessageId: s?.id, estado: s?.status, error: s?.errors });
      }
    }
  }
  return { mensajes, estados };
}

// ---------------------------------------------------------------------------
// Envío
// ---------------------------------------------------------------------------
function token(): string {
  const t = Deno.env.get("WA_TOKEN");
  if (!t) throw new Error("Falta el secreto WA_TOKEN");
  return t;
}

export async function enviarTexto(
  phoneNumberId: string,
  to: string,
  texto: string,
): Promise<{ waMessageId?: string; error?: unknown }> {
  const r = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: texto },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { error: j?.error ?? { status: r.status } };
  return { waMessageId: j?.messages?.[0]?.id };
}

async function enviar(
  phoneNumberId: string,
  // deno-lint-ignore no-explicit-any
  cuerpo: Record<string, any>,
): Promise<{ waMessageId?: string; error?: unknown }> {
  const r = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...cuerpo }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { error: j?.error ?? { status: r.status } };
  return { waMessageId: j?.messages?.[0]?.id };
}

/** Imagen por URL pública (ej. la etiqueta con QR), con texto al pie */
export function enviarImagen(phoneNumberId: string, to: string, url: string, caption?: string) {
  return enviar(phoneNumberId, {
    to, type: "image",
    image: { link: url, ...(caption ? { caption: caption.slice(0, 1024) } : {}) },
  });
}

/** Hasta 3 botones de respuesta rápida. El id vuelve como texto del mensaje. */
export function enviarBotones(
  phoneNumberId: string,
  to: string,
  texto: string,
  botones: { id: string; titulo: string }[],
) {
  return enviar(phoneNumberId, {
    to, type: "interactive",
    interactive: {
      type: "button",
      body: { text: texto.slice(0, 1024) },
      action: {
        buttons: botones.slice(0, 3).map((b) => ({
          type: "reply", reply: { id: b.id.slice(0, 256), title: b.titulo.slice(0, 20) },
        })),
      },
    },
  });
}

/** Descarga un archivo de Meta (foto, audio) a partir de su media id. */
export async function descargarMedia(
  mediaId: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const meta = await fetch(`${GRAPH}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  if (!meta.ok) throw new Error(`Meta media ${mediaId}: ${meta.status}`);
  const { url, mime_type } = await meta.json();
  const archivo = await fetch(url, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  if (!archivo.ok) throw new Error(`Descarga media ${mediaId}: ${archivo.status}`);
  return {
    bytes: new Uint8Array(await archivo.arrayBuffer()),
    mimeType: mime_type ?? "application/octet-stream",
  };
}

export function extension(mime: string | undefined): string {
  const m = (mime ?? "").split(";")[0].trim();
  return ({
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "application/pdf": "pdf",
  } as Record<string, string>)[m] ?? "bin";
}
