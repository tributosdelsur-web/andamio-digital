import assert from "node:assert/strict";
import { interpretar, manejarPrendas, peso, numero, type Articulo, type RepoPrendas } from "../_shared/prendas.ts";
import type { EntradaModulo } from "../_shared/modulos.ts";

function repoMemoria(precioKg: number | null = 12000, leido: string | null = null) {
  const arts: (Articulo & { foto?: string; fotoVenta?: string })[] = [];
  let n = 0;
  const codigos = ["K7M3Q", "P4XR9", "ZZ22A"];
  const r: RepoPrendas & { arts: typeof arts; precio: number | null } = {
    arts, precio: precioKg,
    async config() { return { precio_kg: r.precio, slug: "tienda-flores", catalogo_publico: true }; },
    async guardarPrecioKg(p) { r.precio = p; },
    async buscar(cs) { for (const c of cs) { const a = arts.find((x) => x.codigo === c); if (a) return a; } return null; },
    async crear({ peso_kg, precio_kg, fotoPath }) {
      const a = { id: "id" + n, codigo: codigos[n++], estado: "en_stock" as const, peso_kg, precio: Math.round(peso_kg * precio_kg * 100) / 100, foto: fotoPath };
      arts.push(a); return a;
    },
    async cambiarEstado(id, estado, f) { const a = arts.find((x) => x.id === id)!; a.estado = estado; if (f) a.fotoVenta = f; },
    async resumen() { const s = arts.filter((a) => a.estado === "en_stock"); return { en_stock: s.length, kg: s.reduce((t, a) => t + (a.peso_kg ?? 0), 0), valor: s.reduce((t, a) => t + (a.precio ?? 0), 0) }; },
    async leerCodigoEnFoto() { return leido; },
    urlCatalogo: (s) => "https://x.test/catalogo.html?c=" + s,
  };
  return r;
}

let sesion: { paso?: string | null; datos: Record<string, unknown> } = { paso: null, datos: {} };
async function enviar(repo: RepoPrendas, o: { texto?: string; foto?: string; idioma?: "es" | "zh" }) {
  const e: EntradaModulo = {
    comercioId: "c1", idioma: o.idioma ?? "es",
    mensaje: { waMessageId: "w", phoneNumberId: "p", from: "1", tipo: o.foto ? "image" : "text", texto: o.texto, timestamp: 0, raw: {} },
    mediaPath: o.foto, sesion,
  };
  const s = await manejarPrendas(e, repo);
  sesion = { paso: s.paso === undefined ? sesion.paso : s.paso, datos: s.datos ?? sesion.datos };
  return s.respuesta;
}

Deno.test("peso: formatos en español y chino", () => {
  assert.equal(peso("0,85"), 0.85);
  assert.equal(peso("0.85 kg"), 0.85);
  assert.equal(peso("850 g"), 0.85);
  assert.equal(peso("850gr"), 0.85);
  assert.equal(peso("850"), 0.85);
  assert.equal(peso("1.7斤"), 0.85);
  assert.equal(peso("０.８５公斤"), 0.85);
  assert.equal(peso("850克"), 0.85);
  assert.equal(peso("2 kilos"), 2);
  assert.equal(peso("12000"), undefined);
  assert.equal(peso("hola"), undefined);
});

Deno.test("numero: separadores de miles", () => {
  assert.equal(numero("12.000"), 12000);
  assert.equal(numero("$ 12.500,50"), 12500.5);
  assert.equal(numero("12,000"), 12000);
  assert.equal(numero("0,85"), 0.85);
});

Deno.test("interpretar: acciones y códigos", () => {
  assert.deepEqual(interpretar("vendí K7M3Q").accion, "venta");
  assert.deepEqual(interpretar("vendí k7m3q").codigos, ["K7M3Q"]);
  assert.equal(interpretar("卖出K7M3Q").accion, "venta");
  assert.deepEqual(interpretar("卖出K7M3Q").codigos, ["K7M3Q"]);
  assert.equal(interpretar("precio 12.000").monto, 12000);
  assert.equal(interpretar("价格 12000").monto, 12000);
  assert.equal(interpretar("库存").accion, "stock");
  assert.equal(interpretar("0,85").pesoKg, 0.85);
  assert.equal(interpretar("vendí camperas").codigos.length, 0);
  assert.equal(interpretar("deshacer P4XR9").accion, "deshacer");
});

Deno.test("alta con foto y peso en el pie → código", async () => {
  const r = repoMemoria(); sesion = { paso: null, datos: {} };
  const t = await enviar(r, { foto: "c1/f1.jpg", texto: "0,85" });
  assert.match(t, /K7M3Q/); assert.match(t, /\$10\.200/);
  assert.equal(r.arts[0].foto, "c1/f1.jpg");
});

Deno.test("alta en dos pasos: foto, después peso", async () => {
  const r = repoMemoria(); sesion = { paso: null, datos: {} };
  const t1 = await enviar(r, { foto: "c1/f2.jpg" });
  assert.match(t1, /Cuánto pesa/); assert.equal(sesion.paso, "prenda_foto");
  const t2 = await enviar(r, { texto: "850 g" });
  assert.match(t2, /K7M3Q/); assert.equal(r.arts[0].foto, "c1/f2.jpg"); assert.equal(sesion.paso, null);
});

Deno.test("sin precio por kilo: lo pide y completa el alta", async () => {
  const r = repoMemoria(null); sesion = { paso: null, datos: {} };
  const t1 = await enviar(r, { foto: "c1/f3.jpg", texto: "1 kg" });
  assert.match(t1, /A cuánto vendés el kilo/);
  const t2 = await enviar(r, { texto: "10.000" });
  assert.equal(r.precio, 10000); assert.match(t2, /K7M3Q/); assert.match(t2, /\$10\.000/);
  assert.equal(r.arts[0].foto, "c1/f3.jpg");
});

Deno.test("venta por texto, deshacer y stock", async () => {
  const r = repoMemoria(); sesion = { paso: null, datos: {} };
  await enviar(r, { texto: "0,85" }); await enviar(r, { texto: "0,5" });
  const t = await enviar(r, { texto: "vendí K7M3Q" });
  assert.match(t, /vendida/); assert.match(t, /Quedan 1/);
  assert.match(await enviar(r, { texto: "vendí K7M3Q" }), /ya está vendida/);
  assert.match(await enviar(r, { texto: "deshacer K7M3Q" }), /volvió al stock/);
  assert.match(await enviar(r, { texto: "stock" }), /En stock: 2 prendas/);
  assert.match(await enviar(r, { texto: "vendí ABCDE" }), /No encuentro el código ABCDE/);
});

Deno.test("venta por foto de la etiqueta con lectura automática", async () => {
  const r = repoMemoria(12000, "K7M3Q"); sesion = { paso: null, datos: {} };
  await enviar(r, { texto: "0,85" });
  const t = await enviar(r, { foto: "c1/etiqueta.jpg" });
  assert.match(t, /K7M3Q vendida/); assert.equal(r.arts[0].fotoVenta, "c1/etiqueta.jpg");
});

Deno.test("foto de etiqueta que no se lee: pregunta y acepta el código", async () => {
  const r = repoMemoria(12000, null); sesion = { paso: null, datos: {} };
  await enviar(r, { texto: "0,85" });
  const t1 = await enviar(r, { foto: "c1/etiqueta.jpg" });
  assert.match(t1, /mandame el código/);
  const t2 = await enviar(r, { texto: "K7M3Q" });
  assert.match(t2, /K7M3Q vendida/); assert.equal(r.arts[0].fotoVenta, "c1/etiqueta.jpg");
  assert.equal(r.arts.length, 1);
});

Deno.test("en chino", async () => {
  const r = repoMemoria(); sesion = { paso: null, datos: {} };
  const t1 = await enviar(r, { foto: "c1/f.jpg", texto: "1.7斤", idioma: "zh" });
  assert.match(t1, /编号：\*K7M3Q\*/); assert.match(t1, /0\.85 公斤/);
  assert.match(await enviar(r, { texto: "卖出 K7M3Q", idioma: "zh" }), /已卖出/);
  assert.match(await enviar(r, { texto: "库存", idioma: "zh" }), /库存：0 件/);
  assert.match(await enviar(r, { texto: "目录", idioma: "zh" }), /tienda-flores/);
  assert.match(await enviar(r, { texto: "帮助", idioma: "zh" }), /单件管理/);
});
