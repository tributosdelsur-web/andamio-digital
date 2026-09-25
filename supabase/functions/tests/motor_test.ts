// deno test supabase/functions/tests/
import { deepStrictEqual as assertEquals, ok as assert } from "node:assert";
import { decidir, textoMenu } from "../_shared/router.ts";
import { firmaValida, parsearWebhook } from "../_shared/whatsapp.ts";

const U = { comercioId: "c1", idioma: "es" as const };

Deno.test("un solo módulo: va directo", () => {
  const d = decidir({ usuario: U, modulosActivos: ["chino"], comerciosComoCliente: [], texto: "hola" });
  assertEquals(d.accion, "modulo");
  if (d.accion === "modulo") assertEquals(d.modulo, "chino");
});

Deno.test("varios módulos sin sesión: menú", () => {
  const d = decidir({ usuario: U, modulosActivos: ["mermas", "chino"], comerciosComoCliente: [] });
  assertEquals(d.accion, "menu");
  if (d.accion === "menu") assertEquals(d.opciones, ["chino", "mermas"]); // orden fijo
});

Deno.test("elige del menú con número", () => {
  const d = decidir({
    usuario: U, modulosActivos: ["chino", "mermas"], comerciosComoCliente: [],
    sesion: { paso: "elegir_modulo" }, texto: "2",
  });
  assertEquals(d.accion, "modulo");
  if (d.accion === "modulo") assertEquals(d.modulo, "mermas");
});

Deno.test("número fuera de rango vuelve al menú", () => {
  const d = decidir({
    usuario: U, modulosActivos: ["chino", "mermas"], comerciosComoCliente: [],
    sesion: { paso: "elegir_modulo" }, texto: "7",
  });
  assertEquals(d.accion, "menu");
});

Deno.test("sigue en el módulo de la sesión; «menú» lo saca", () => {
  const base = { usuario: U, modulosActivos: ["chino", "mermas"] as const, comerciosComoCliente: [] };
  const d1 = decidir({ ...base, modulosActivos: [...base.modulosActivos], sesion: { modulo: "mermas" }, texto: "foto" });
  assertEquals(d1.accion === "modulo" && d1.modulo, "mermas");
  const d2 = decidir({ ...base, modulosActivos: [...base.modulosActivos], sesion: { modulo: "mermas" }, texto: "Menú" });
  assertEquals(d2.accion, "menu");
});

Deno.test("comercio sin módulos", () => {
  assertEquals(decidir({ usuario: U, modulosActivos: [], comerciosComoCliente: [] }).accion, "sin_modulos");
});

Deno.test("clientes del turnero y desconocidos", () => {
  assertEquals(decidir({ modulosActivos: [], comerciosComoCliente: ["c9"] }).accion, "cliente_turnero");
  assertEquals(decidir({ modulosActivos: [], comerciosComoCliente: ["c1", "c2"] }).accion, "cliente_ambiguo");
  assertEquals(decidir({ modulosActivos: [], comerciosComoCliente: [] }).accion, "desconocido");
});

Deno.test("menú en chino", () => {
  assert(textoMenu("zh", ["chino"]).includes("送货单"));
});

Deno.test("parseo del payload de Meta", () => {
  const body = {
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "5491100000000", phone_number_id: "PNID" },
          contacts: [{ profile: { name: "Li" }, wa_id: "5491112345678" }],
          messages: [
            { from: "5491112345678", id: "wamid.A", timestamp: "1790000000", type: "text", text: { body: "hola" } },
            { from: "5491112345678", id: "wamid.B", timestamp: "1790000001", type: "image",
              image: { id: "MEDIA1", mime_type: "image/jpeg", caption: "guía" } },
            { from: "5491112345678", id: "wamid.C", timestamp: "1790000002", type: "interactive",
              interactive: { type: "button_reply", button_reply: { id: "si", title: "Sí" } } },
          ],
          statuses: [{ id: "wamid.OUT", status: "delivered" }],
        },
        field: "messages",
      }],
    }],
  };
  const { mensajes, estados } = parsearWebhook(body);
  assertEquals(mensajes.length, 3);
  assertEquals(mensajes[0].texto, "hola");
  assertEquals(mensajes[0].nombrePerfil, "Li");
  assertEquals(mensajes[1].mediaId, "MEDIA1");
  assertEquals(mensajes[1].texto, "guía");
  assertEquals(mensajes[2].texto, "si");
  assertEquals(estados, [{ waMessageId: "wamid.OUT", estado: "delivered", error: undefined }]);
});

Deno.test("firma del webhook", async () => {
  const cuerpo = '{"a":1}';
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("secreto"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(cuerpo)));
  const hex = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  assert(await firmaValida(cuerpo, `sha256=${hex}`, "secreto"));
  assert(!(await firmaValida(cuerpo, `sha256=${hex}`, "otro")));
  assert(!(await firmaValida('{"a":2}', `sha256=${hex}`, "secreto")));
  assert(!(await firmaValida(cuerpo, null, "secreto")));
});

// --- Prueba gratuita de 7 días ------------------------------------------------
import { acceso } from "../_shared/router.ts";

const D = 24 * 3600 * 1000;
const fin = new Date("2026-10-08T12:00:00Z");

Deno.test("prueba: habilitado sin aviso al principio", () => {
  const a = acceso("prueba", fin, new Date(fin.getTime() - 6 * D));
  assertEquals(a.habilitado, true);
  assertEquals(a.aviso, undefined);
});

Deno.test("prueba: avisa una sola vez cuando quedan 2 días", () => {
  const ahora = new Date(fin.getTime() - 1.5 * D);
  const a1 = acceso("prueba", fin, ahora, null);
  assertEquals([a1.habilitado, a1.aviso, a1.diasRestantes], [true, "quedan_dias", 2]);
  const a2 = acceso("prueba", fin, new Date(ahora.getTime() + 3600e3), ahora);
  assertEquals(a2.aviso, undefined);
});

Deno.test("prueba vencida: bloquea y avisa, sin repetir el mismo día", () => {
  const venc = new Date(fin.getTime() + 3600e3);
  const a1 = acceso("prueba", fin, venc, new Date(fin.getTime() - D)); // último aviso fue el de "quedan días"
  assertEquals([a1.habilitado, a1.aviso], [false, "vencida"]);
  const a2 = acceso("prueba", fin, new Date(venc.getTime() + 3600e3), venc);
  assertEquals([a2.habilitado, a2.aviso], [false, undefined]);
  const a3 = acceso("prueba", fin, new Date(venc.getTime() + D + 1), venc);
  assertEquals(a3.aviso, "vencida");
});

Deno.test("piloto y activo no vencen; pausado bloquea", () => {
  const lejos = new Date(fin.getTime() + 100 * D);
  assertEquals(acceso("piloto", fin, lejos).habilitado, true);
  assertEquals(acceso("activo", fin, lejos).habilitado, true);
  assertEquals(acceso("pausado", fin, lejos).habilitado, false);
});

// --- Idiomas por módulo ---------------------------------------------------------
import { MANEJADORES } from "../_shared/modulos.ts";

Deno.test("Andamio Chino y Etiqueta Visión responden en chino", async () => {
  const base = { comercioId: "c1", sesion: { datos: {} } };
  const msg = { waMessageId: "w", phoneNumberId: "p", from: "549", tipo: "image", timestamp: 0, raw: {} };
  for (const m of ["chino", "etiqueta"] as const) {
    const zh = await MANEJADORES[m]({ ...base, idioma: "zh", mensaje: msg });
    assert(/[一-鿿]/.test(zh.respuesta), `${m} en chino`);
    const es = await MANEJADORES[m]({ ...base, idioma: "es", mensaje: msg });
    assert(!/[一-鿿]/.test(es.respuesta), `${m} en español`);
  }
});
