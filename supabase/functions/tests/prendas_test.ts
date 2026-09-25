// deno test --allow-env supabase/functions/tests/
import assert from "node:assert/strict";
import {
  type Articulo, type EstadoArticulo, type Evento, interpretar, manejarPrendas, numero, peso,
  type RepoPrendas, type Tramo,
} from "../_shared/prendas.ts";
import type { EntradaModulo, SalidaModulo } from "../_shared/modulos.ts";
import { contenidoQr, detalleEtiqueta, etiquetaPng } from "../_shared/etiqueta_png.ts";

const TRAMOS: Tramo[] = [
  { orden: 1, nombre_es: "Chico", nombre_zh: "小", hasta: 300, cuota_usd: 37 },
  { orden: 2, nombre_es: "Mediano", nombre_zh: "中", hasta: 1000, cuota_usd: 65 },
  { orden: 3, nombre_es: "Grande", nombre_zh: "大", hasta: null, cuota_usd: 95 },
];

function repoMemoria(precioKg: number | null = 12000, leido: string | null = null, altasPrevias = 0) {
  const arts: (Articulo & { foto?: string; fotoVenta?: string })[] = [];
  const eventos: (Evento & { id: string })[] = [];
  let n = 0;
  const codigos = ["K7M3Q", "P4XR9", "ZZ22A", "HH33B"];
  const r: RepoPrendas & { arts: typeof arts; precio: number | null } = {
    arts, precio: precioKg,
    async config() { return { precio_kg: r.precio, slug: "tienda-flores", catalogo_publico: true }; },
    async guardarPrecioKg(p) { r.precio = p; },
    async buscar(cs) { for (const c of cs) { const a = arts.find((x) => x.codigo === c); if (a) return a; } return null; },
    async crear({ peso_kg, precio_kg, fotoPath }) {
      const a = { id: "id" + n, codigo: codigos[n++], estado: "en_stock" as EstadoArticulo, entrega: null, envio_nota: null, peso_kg, precio: Math.round(peso_kg * precio_kg * 100) / 100, foto: fotoPath };
      arts.push(a); eventos.push({ id: a.id, evento: "alta", created_at: new Date().toISOString() }); return a;
    },
    async cambiarEstado(a0, estado, o) {
      const a = arts.find((x) => x.id === a0.id)!;
      a.estado = estado; a.entrega = estado === "en_stock" ? null : o.entrega ?? null;
      if (o.nota !== undefined) a.envio_nota = o.nota; if (estado === "en_stock") a.envio_nota = null;
      if (o.foto) a.fotoVenta = o.foto;
      eventos.push({ id: a.id, evento: estado, entrega: o.entrega, nota: o.nota, created_at: new Date().toISOString() });
    },
    async resumen() { const s = arts.filter((a) => a.estado === "en_stock"); return { en_stock: s.length, kg: s.reduce((t, a) => t + (a.peso_kg ?? 0), 0), valor: s.reduce((t, a) => t + (a.precio ?? 0), 0) }; },
    async pendientes() { return arts.filter((a) => a.estado === "reservado" || a.estado === "en_camino"); },
    async historial(a) { return eventos.filter((e) => e.id === a.id); },
    async uso() {
      const altas = altasPrevias + arts.length;
      const tramo = TRAMOS.find((t) => t.hasta === null || t.hasta >= altas)!;
      return { altas, tramo, tramos: TRAMOS };
    },
    async etiqueta(a) { return `https://x.test/etiquetas/${a.codigo}.png`; },
    async leerCodigoEnFoto() { return leido; },
    urlCatalogo: (s) => "https://x.test/catalogo.html?c=" + s,
  };
  return r;
}

let sesion: { paso?: string | null; datos: Record<string, unknown> } = { paso: null, datos: {} };
async function enviar(repo: RepoPrendas, o: { texto?: string; foto?: string; idioma?: "es" | "zh" }): Promise<SalidaModulo> {
  const e: EntradaModulo = {
    comercioId: "c1", idioma: o.idioma ?? "es",
    mensaje: { waMessageId: "w", phoneNumberId: "p", from: "1", tipo: o.foto ? "image" : "text", texto: o.texto, timestamp: 0, raw: {} },
    mediaPath: o.foto, sesion,
  };
  const s = await manejarPrendas(e, repo);
  sesion = { paso: s.paso === undefined ? sesion.paso : s.paso, datos: s.datos ?? sesion.datos };
  return s;
}
const txt = async (repo: RepoPrendas, o: { texto?: string; foto?: string; idioma?: "es" | "zh" }) => (await enviar(repo, o)).respuesta;
const nuevo = (...a: Parameters<typeof repoMemoria>) => { sesion = { paso: null, datos: {} }; return repoMemoria(...a); };

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

Deno.test("interpretar: acciones, códigos y notas", () => {
  assert.equal(interpretar("vendí K7M3Q").accion, "venta");
  assert.deepEqual(interpretar("vendí k7m3q").codigos, ["K7M3Q"]);
  assert.equal(interpretar("卖出K7M3Q").accion, "venta");
  assert.deepEqual(interpretar("卖出K7M3Q").codigos, ["K7M3Q"]);
  assert.equal(interpretar("precio 12.000").monto, 12000);
  assert.equal(interpretar("价格 12000").monto, 12000);
  assert.equal(interpretar("库存").accion, "stock");
  assert.equal(interpretar("0,85").pesoKg, 0.85);
  assert.equal(interpretar("vendí camperas").codigos.length, 0);
  assert.equal(interpretar("deshacer P4XR9").accion, "deshacer");
  const e = interpretar("envío K7M3Q PedidosYa https://seg.test/1");
  assert.equal(e.accion, "envio"); assert.equal(e.nota, "PedidosYa https://seg.test/1");
  const r = interpretar("reservar para envío K7M3Q");
  assert.equal(r.accion, "reservar"); assert.equal(r.paraEnvio, true);
  assert.equal(interpretar("entregado K7M3Q").accion, "entregado");
  assert.equal(interpretar("发货 K7M3Q").accion, "envio");
  assert.equal(interpretar("pendientes").accion, "pendientes");
  assert.equal(interpretar("待处理").accion, "pendientes");
  assert.equal(interpretar("historial K7M3Q").accion, "historial");
  assert.equal(interpretar("uso").accion, "uso");
});

Deno.test("alta: foto + peso → etiqueta con QR", async () => {
  const r = nuevo();
  const s = await enviar(r, { foto: "c1/f1.jpg", texto: "0,85" });
  assert.match(s.respuesta, /K7M3Q/); assert.match(s.respuesta, /\$10\.200/); assert.match(s.respuesta, /Imprimí/);
  assert.equal(s.imagen, "https://x.test/etiquetas/K7M3Q.png");
  assert.equal(r.arts[0].foto, "c1/f1.jpg");
});

Deno.test("alta en dos pasos: foto, después peso", async () => {
  const r = nuevo();
  assert.match(await txt(r, { foto: "c1/f2.jpg" }), /Cuánto pesa/); assert.equal(sesion.paso, "prenda_foto");
  assert.match(await txt(r, { texto: "850 g" }), /K7M3Q/); assert.equal(r.arts[0].foto, "c1/f2.jpg");
});

Deno.test("sin precio por kilo: lo pide y completa el alta", async () => {
  const r = nuevo(null);
  assert.match(await txt(r, { foto: "c1/f3.jpg", texto: "1 kg" }), /A cuánto vendés el kilo/);
  const t2 = await txt(r, { texto: "10.000" });
  assert.equal(r.precio, 10000); assert.match(t2, /K7M3Q/); assert.match(t2, /\$10\.000/);
});

Deno.test("escaneo en stock → reserva para retiro → la retiraron", async () => {
  const r = nuevo();
  await enviar(r, { texto: "0,85" });
  const s1 = await enviar(r, { texto: "K7M3Q" });
  assert.match(s1.respuesta, /en stock/);
  assert.deepEqual(s1.botones?.map((b) => b.id), ["1", "2", "3"]);
  assert.deepEqual(s1.botones?.map((b) => b.titulo), ["1 Vendida en local", "2 Reservar p/ retiro", "3 Reservar p/ envío"]);
  assert.ok(s1.botones!.every((b) => b.titulo.length <= 20));
  assert.match(await txt(r, { texto: "2" }), /reservada para retiro/);
  assert.equal(r.arts[0].estado, "reservado"); assert.equal(r.arts[0].entrega, "retiro");
  const s2 = await enviar(r, { texto: "K7M3Q" });
  assert.deepEqual(s2.botones?.map((b) => b.titulo), ["1 Ya la retiraron", "2 Liberar"]);
  assert.match(await txt(r, { texto: "1" }), /retirada por el cliente/);
  assert.equal(r.arts[0].estado, "entregado"); assert.equal(r.arts[0].entrega, "retiro");
  const h = await txt(r, { texto: "historial K7M3Q" });
  assert.match(h, /alta/); assert.match(h, /reservada \(retiro en tienda\)/); assert.match(h, /entregada \(retiro en tienda\)/);
});

Deno.test("envío tercerizado: reserva, sale con nota, pendientes, entregada", async () => {
  const r = nuevo();
  await enviar(r, { texto: "0,85" }); await enviar(r, { texto: "0,5" });
  await enviar(r, { texto: "K7M3Q" });
  assert.match(await txt(r, { texto: "3" }), /reservada para envío/);
  assert.match(await txt(r, { texto: "pendientes" }), /K7M3Q\* · reservada \(envío\)/);
  const t = await txt(r, { texto: "envío K7M3Q PedidosYa https://seg.test/1" });
  assert.match(t, /en camino \(PedidosYa https:\/\/seg\.test\/1\)/);
  assert.equal(r.arts[0].estado, "en_camino");
  assert.match(await txt(r, { texto: "pendientes" }), /K7M3Q\* · en camino \(envío\) · PedidosYa/);
  const s = await enviar(r, { texto: "K7M3Q" });
  assert.deepEqual(s.botones?.map((b) => b.titulo), ["1 Entregada", "2 Volvió a la tienda"]);
  assert.match(await txt(r, { texto: "1" }), /entregada/);
  assert.equal(r.arts[0].estado, "entregado"); assert.equal(r.arts[0].entrega, "envio");
  assert.match(await txt(r, { texto: "pendientes" }), /No hay reservas/);
});

Deno.test("venta por texto, deshacer, stock y pasos que no corresponden", async () => {
  const r = nuevo();
  await enviar(r, { texto: "0,85" }); await enviar(r, { texto: "0,5" });
  const t = await txt(r, { texto: "vendí K7M3Q" });
  assert.match(t, /vendida en el local/); assert.match(t, /Quedan 1/);
  assert.match(await txt(r, { texto: "entregado P4XR9" }), /no corresponde/);
  assert.match(await txt(r, { texto: "deshacer K7M3Q" }), /volvió al stock/);
  assert.match(await txt(r, { texto: "stock" }), /En stock: 2 prendas/);
  assert.match(await txt(r, { texto: "vendí ABCDE" }), /No encuentro el código ABCDE/);
});

Deno.test("foto de la etiqueta: con lectura automática muestra las opciones", async () => {
  const r = nuevo(12000, "K7M3Q");
  await enviar(r, { texto: "0,85" });
  const s = await enviar(r, { foto: "c1/etiqueta.jpg" });
  assert.equal(s.botones?.length, 3); assert.equal(sesion.paso, "prenda_menu");
});

Deno.test("foto sin lectura: pregunta, y el código lleva a las opciones", async () => {
  const r = nuevo(12000, null);
  await enviar(r, { texto: "0,85" });
  assert.match(await txt(r, { foto: "c1/etiqueta.jpg" }), /mandame el código/);
  const s = await enviar(r, { texto: "K7M3Q" });
  assert.equal(s.botones?.length, 3); assert.equal(r.arts.length, 1);
});

Deno.test("en el menú, un peso es un alta nueva y no una opción", async () => {
  const r = nuevo();
  await enviar(r, { texto: "0,85" }); await enviar(r, { texto: "K7M3Q" });
  assert.match(await txt(r, { texto: "1 kg" }), /P4XR9/);
  assert.equal(r.arts[0].estado, "en_stock"); assert.equal(r.arts.length, 2);
});

Deno.test("tramos: uso del mes y aviso al pasar de tramo", async () => {
  const r = nuevo(12000, null, 299);
  assert.doesNotMatch(await txt(r, { texto: "0,85" }), /tramo/); // alta 300
  assert.match(await txt(r, { texto: "0,5" }), /pasás al tramo Mediano \(USD 65\/mes\)/); // alta 301
  const u = await txt(r, { texto: "uso" });
  assert.match(u, /301 prendas/); assert.match(u, /Tramo Mediano \(hasta 1\.000\) · USD 65\/mes/); assert.match(u, /700 altas más/);
});

Deno.test("en chino", async () => {
  const r = nuevo();
  const s = await enviar(r, { foto: "c1/f.jpg", texto: "1.7斤", idioma: "zh" });
  assert.match(s.respuesta, /编号：\*K7M3Q\*/); assert.match(s.respuesta, /0\.85 公斤/); assert.ok(s.imagen);
  const m = await enviar(r, { texto: "K7M3Q", idioma: "zh" });
  assert.deepEqual(m.botones?.map((b) => b.titulo), ["1 店内已售", "2 预留到店取", "3 预留配送"]);
  assert.match(await txt(r, { texto: "3", idioma: "zh" }), /已预留配送/);
  assert.match(await txt(r, { texto: "发货 K7M3Q 顺丰", idioma: "zh" }), /配送中（顺丰）/);
  assert.match(await txt(r, { texto: "已送达 K7M3Q", idioma: "zh" }), /已送达/);
  assert.match(await txt(r, { texto: "库存", idioma: "zh" }), /库存：0 件/);
  assert.match(await txt(r, { texto: "用量", idioma: "zh" }), /本月上架：1 件/);
  assert.match(await txt(r, { texto: "目录", idioma: "zh" }), /tienda-flores/);
  assert.match(await txt(r, { texto: "帮助", idioma: "zh" }), /单件管理/);
});

Deno.test("etiqueta PNG y contenido del QR", () => {
  assert.equal(contenidoQr("+54 9 11 5555-0000", "K7M3Q"), "https://wa.me/5491155550000?text=K7M3Q");
  assert.equal(contenidoQr(undefined, "K7M3Q"), "K7M3Q");
  assert.equal(detalleEtiqueta(0.85, 10200), "0,85 KG  $10.200");
  const png = etiquetaPng({ codigo: "K7M3Q", contenidoQr: "https://wa.me/5491155550000?text=K7M3Q", detalle: "0,85 KG  $10.200" });
  assert.deepEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const dv = new DataView(png.buffer, png.byteOffset);
  assert.equal(dv.getUint32(16), 480);
  assert.ok(png.length < 20_000);
});

Deno.test("el webhook trae el número visible del bot (para el QR)", async () => {
  const { parsearWebhook } = await import("../_shared/whatsapp.ts");
  const { mensajes } = parsearWebhook({ entry: [{ changes: [{ value: {
    metadata: { phone_number_id: "123", display_phone_number: "+54 9 11 5555-0000" },
    messages: [{ id: "wamid.1", from: "5491100000000", type: "text", text: { body: "K7M3Q" }, timestamp: "1" }],
  } }] }] });
  assert.equal(mensajes[0].numeroBot, "5491155550000");
});
