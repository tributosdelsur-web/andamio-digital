// Andamio Digital · lectura de imágenes con Cloudflare Workers AI (plan gratuito)
// Variables: CF_ACCOUNT_ID y CF_AI_TOKEN. Si faltan, las funciones devuelven null
// y el bot le pide el dato a la persona: nunca se traba por la IA.
//
// Nota: los modelos Llama de Meta en Workers AI piden aceptar su licencia una vez
// (mandar el texto «agree» como prompt). Ver MOTOR.md.

const MODELO_VISION = Deno.env.get("CF_VISION_MODEL") ?? "@cf/meta/llama-3.2-11b-vision-instruct";
const RE_CODIGO = /(?<![A-Z0-9])[2-9A-HJKMNP-Z]{5}(?![A-Z0-9])/;

export async function leerCodigoEtiqueta(imagen: Uint8Array): Promise<string | null> {
  const cuenta = Deno.env.get("CF_ACCOUNT_ID");
  const token = Deno.env.get("CF_AI_TOKEN");
  if (!cuenta || !token) return null;
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cuenta}/ai/run/${MODELO_VISION}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        image: Array.from(imagen),
        prompt: "This photo shows a clothing price tag with a 5-character code written on it " +
          "(uppercase letters and digits, never 0, O, 1, I or L). Reply with the code only. " +
          "If you cannot read it, reply NONE.",
        max_tokens: 12,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.error("Workers AI", res.status, await res.text().catch(() => ""));
      return null;
    }
    const j = await res.json();
    const texto = String(j?.result?.response ?? j?.result?.description ?? "").toUpperCase()
      .replace(/0/g, "O").replace(/[1I]/g, "L"); // nunca están: si aparecen, no es un código válido
    return texto.match(RE_CODIGO)?.[0] ?? null;
  } catch (e) {
    console.error("Workers AI", e);
    return null;
  }
}
