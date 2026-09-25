// Andamio Digital · lectura de imágenes con Cloudflare Workers AI (plan gratuito)
// Variables: CF_ACCOUNT_ID y CF_AI_TOKEN. Si faltan, las funciones devuelven null
// y el bot le pide el dato a la persona: nunca se traba por la IA.
//
// Nota: los modelos Llama de Meta en Workers AI piden aceptar su licencia una vez
// (mandar el texto «agree» como prompt). Ver MOTOR.md.

const MODELO_VISION = Deno.env.get("CF_VISION_MODEL") ?? "@cf/meta/llama-3.2-11b-vision-instruct";
const RE_CODIGO = /(?<![A-Z0-9])[2-9A-HJKMNP-Z]{5}(?![A-Z0-9])/;

async function vision(imagen: Uint8Array, prompt: string, maxTokens: number): Promise<string | null> {
  const cuenta = Deno.env.get("CF_ACCOUNT_ID");
  const token = Deno.env.get("CF_AI_TOKEN");
  if (!cuenta || !token) return null;
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cuenta}/ai/run/${MODELO_VISION}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ image: Array.from(imagen), prompt, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
      console.error("Workers AI", res.status, await res.text().catch(() => ""));
      return null;
    }
    const j = await res.json();
    return String(j?.result?.response ?? j?.result?.description ?? "");
  } catch (e) {
    console.error("Workers AI", e);
    return null;
  }
}

/** Código de 5 caracteres en una etiqueta de Andamio (modo QR) */
export async function leerCodigoEtiqueta(imagen: Uint8Array): Promise<string | null> {
  const r = await vision(
    imagen,
    "This photo shows a clothing price tag with a 5-character code written on it " +
      "(uppercase letters and digits, never 0, O, 1, I or L). Reply with the code only. " +
      "If you cannot read it, reply NONE.",
    12,
  );
  if (!r) return null;
  const texto = r.toUpperCase().replace(/0/g, "O").replace(/[1I]/g, "L"); // nunca están: no es un código válido
  return texto.match(RE_CODIGO)?.[0] ?? null;
}

export interface LecturaPrenda {
  precio: number | null;
  es: string | null;
  zh: string | null;
}

/** «10.200» · «$10200» · 10200 → 10200 (pesos argentinos, sin centavos) */
export function precioLeido(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/[^\d.,]/g, "");
  if (!s) return null;
  // En Argentina el punto separa miles: «10.200» = 10200. Una coma final con 1-2 dígitos son centavos.
  const sinCentavos = s.replace(/,\d{1,2}$/, "");
  const n = Number(sinCentavos.replace(/[.,]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Interpreta la respuesta del modelo (JSON, a veces con texto alrededor) */
export function parsearLectura(r: string): LecturaPrenda | null {
  const m = r.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const txt = (x: unknown) => (typeof x === "string" && x.trim() && !/^null$/i.test(x.trim()) ? x.trim().slice(0, 60) : null);
    return { precio: precioLeido(j.precio ?? j.price), es: txt(j.es), zh: txt(j.zh) };
  } catch {
    return null;
  }
}

/**
 * Modo «etiquetas propias»: la tienda pega su propia etiqueta con el precio.
 * Devuelve el precio escrito y una descripción corta de la prenda (español y chino).
 */
export async function leerEtiquetaPrenda(imagen: Uint8Array): Promise<LecturaPrenda | null> {
  const r = await vision(
    imagen,
    "Photo of a clothing item in a shop in Argentina, with a price tag (handwritten or printed, " +
      "in Argentine pesos; a dot separates thousands, e.g. 10.200 = 10200). " +
      'Reply ONLY with JSON: {"precio": <price as an integer, or null if you cannot read it>, ' +
      '"es": "<garment type and main color in Spanish, max 4 words>", ' +
      '"zh": "<the same in Simplified Chinese>"}',
    80,
  );
  return r ? parsearLectura(r) : null;
}
