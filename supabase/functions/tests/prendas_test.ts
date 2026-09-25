// deno test --allow-env supabase/functions/tests/
import assert from "node:assert/strict";
import {
  type Articulo, type EstadoArticulo, type Evento, interpretar, manejarPrendas, numero, parecido, peso,
  precioSuelto, type RepoPrendas,
} from "../_shared/prendas.ts";
import { parsearLectura, precioLeido } from "../_shared/ia.ts";
import type { EntradaModulo, SalidaModulo } from "../_shared/modulos.ts";
import { contenidoQr, detalleEtiqueta, etiquetaPng } from "../_shared/etiqueta_png.ts";

const PLAN = { base: 37, incluidas: 300, por_prenda: 0.4, techo: null as number | null };

type Lect = { precio: number | null; es: string | null; zh: string | null };
function repoMemoria(
  precioKg: number | null = 12000, leido: string | null = null, altasPrevias = 0,
  o: { etiquetas?: "qr" | "propias"; lecturas?: Lect[] } = {},
) {
  const etiquetas = o.etiquetas ?? "qr";
  const lecturas = [...(o.lecturas ?? [])];
  const arts: (Articulo & { foto?: string; fotoVenta?: string })[] = [];
  const eventos: (Evento & { id: string })[] = [];
  let n = 0;
  const codigos = ["K7M3Q", "P4XR9", "ZZ22A", "HH33B", "JJ44C", "MM55D", "NN66E"];
  let creadas = 0;
  const r: RepoPrendas & { arts: typeof arts; precio: number | null } = {
    arts, precio: precioKg,
    async config() { return { precio_kg: r.precio, slug: "tienda-flores", catalogo_publico: true, etiquetas }; },
    async guardarPrecioKg(p) { r.precio = p; },
    async buscar(cs) { for (const c of cs) { const a = arts.find((x) => x.codigo === c); if (a) return a; } return null; },
    async crear({ peso_kg, precio_kg, fotoPath, precio_manual, descripcion, descripcion_zh }) {
      creadas++;
      const precio = precio_manual ?? Math.round((peso_kg ?? 0) * (precio_kg ?? 0) * 100) / 100;
      const a = { id: "id" + n, codigo: codigos[n++], estado: "en_stock" as EstadoArticulo, entrega: null, envio_nota: null, peso_kg, precio, descripcion, descripcion_zh, foto: fotoPath };
      arts.push(a); eventos.push({ id: a.id, evento: "alta", created_at: new Date().toISOString() }); return a;
    },
    async corregirPrecio(a0, precio, peso) { const a = arts.find((x) => x.id === a0.id)!; a.precio = precio; a.peso_kg = peso; },
    async eliminar(a0) { const i = arts.findIndex((x) => x.id === a0.id); arts.splice(i, 1); creadas--; },
    async candidatos(precio) { return arts.filter((a) => a.estado === "en_stock" && a.precio === precio); },
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
      const altas = altasPrevias + creadas;
      const extra = Math.max(altas - PLAN.incluidas, 0);
      const cuota = Math.round(Math.min(PLAN.base + extra * PLAN.por_prenda, PLAN.techo ?? Infinity) * 100) / 100;
      return { altas, incluidas: PLAN.incluidas, extra, base: PLAN.base, por_prenda: PLAN.por_prenda, techo: PLAN.techo, cuota };
    },
    async etiqueta(a) { return `https://x.test/etiquetas/${a.codigo}.png`; },
    async leerCodigoEnFoto() { return leido; },
    async leerEtiquetaPrenda() { return lecturas.shift() ?? null; },
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
const L = (precio: number | null, es: string | null, zh: string | null = null): Lect => ({ precio, es, zh });

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

Deno.test("cobro: 37 con 300 incluidas y 0,40 por prenda extra", async () => {
  const r = nuevo(12000, null, 299);
  assert.doesNotMatch(await txt(r, { texto: "0,85" }), /incluidas/); // alta 300
  assert.match(await txt(r, { texto: "0,5" }), /Pasaste las 300 prendas incluidas del mes: desde ahora cada una suma USD 0,40/); // 301
  await enviar(r, { texto: "0,5" }); // 302
  const u = await txt(r, { texto: "uso" });
  assert.match(u, /302 prendas/); assert.match(u, /Cuota USD 37 con 300 incluidas/); assert.match(u, /\+ 2 extra × USD 0,40/); assert.match(u, /Total del mes: \*USD 37,80\*/);
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

// ---------------------------------------------------------------------------
// Modo «etiquetas propias» (por defecto): solo fotos
// ---------------------------------------------------------------------------

Deno.test("lectura de la IA: JSON y precios argentinos", () => {
  assert.equal(precioLeido("10.200"), 10200);
  assert.equal(precioLeido("$10200"), 10200);
  assert.equal(precioLeido("10.200,00"), 10200);
  assert.equal(precioLeido(8500), 8500);
  assert.equal(precioLeido(null), null);
  assert.deepEqual(parsearLectura('Sure! {"precio": "10.200", "es": "campera negra", "zh": "黑色夹克"}'), { precio: 10200, es: "campera negra", zh: "黑色夹克" });
  assert.deepEqual(parsearLectura('{"precio": null, "es": "buzo gris", "zh": null}'), { precio: null, es: "buzo gris", zh: null });
  assert.equal(parsearLectura("no puedo"), null);
  assert.equal(precioSuelto("10200"), 10200);
  assert.equal(precioSuelto("$ 10.200"), 10200);
  assert.equal(precioSuelto("0,85"), null);
  assert.equal(precioSuelto("K7M3Q"), null);
  assert.ok(parecido("campera negra", "Campera negra con capucha") > 0.5);
  assert.equal(parecido("campera negra", "buzo gris"), 0);
});

Deno.test("propias: la foto de entrada lee precio, describe y calcula el peso", async () => {
  const r = nuevo(12000, null, 0, { etiquetas: "propias", lecturas: [L(10200, "campera negra", "黑色夹克")] });
  const s = await enviar(r, { foto: "c1/a.jpg" });
  assert.match(s.respuesta, /Entrada: campera negra · \$10\.200 · ≈0,85 kg/);
  assert.match(s.respuesta, /Si el precio está mal/);
  assert.deepEqual(s.botones?.map((b) => b.titulo), ["1 Era una venta", "2 Borrar"]);
  assert.equal(r.arts[0].precio, 10200); assert.equal(r.arts[0].peso_kg, 0.85); assert.equal(r.arts[0].foto, "c1/a.jpg");
  assert.equal(s.imagen, undefined); // no hay etiqueta nuestra
});

Deno.test("propias: corregir el precio respondiendo con el número", async () => {
  const r = nuevo(12000, null, 0, { etiquetas: "propias", lecturas: [L(10800, "jean azul")] });
  await enviar(r, { foto: "c1/a.jpg" });
  const t = await txt(r, { texto: "10200" });
  assert.match(t, /Corregido: jean azul · \$10\.200 · ≈0,85 kg/);
  assert.equal(r.arts[0].precio, 10200);
});

Deno.test("propias: si no lee el precio, lo pregunta", async () => {
  const r = nuevo(12000, null, 0, { etiquetas: "propias", lecturas: [L(null, "buzo gris")] });
  assert.match(await txt(r, { foto: "c1/a.jpg" }), /No pude leer el precio/);
  assert.match(await txt(r, { texto: "$ 6.000" }), /Entrada: buzo gris · \$6\.000 · ≈0,5 kg/);
});

Deno.test("propias: sin IA, el precio en el pie de foto alcanza", async () => {
  const r = nuevo(12000, null, 0, { etiquetas: "propias" });
  assert.match(await txt(r, { foto: "c1/a.jpg", texto: "9600" }), /Entrada: prenda · \$9\.600 · ≈0,8 kg/);
});

Deno.test("propias: venta con una sola prenda a ese precio", async () => {
  const r = nuevo(12000, null, 0, { etiquetas: "propias", lecturas: [L(10200, "campera negra"), L(6000, "buzo gris"), L(10200, "campera negra")] });
  await enviar(r, { foto: "c1/a.jpg" }); await enviar(r, { foto: "c1/b.jpg" });
  const s = await enviar(r, { foto: "c1/v.jpg", texto: "vendí" });
  assert.match(s.respuesta, /Venta: campera negra · \$10\.200/); assert.match(s.respuesta, /Quedan 1/);
  assert.deepEqual(s.botones?.map((b) => b.titulo), ["1 Era retiro", "2 Era envío", "3 Era una entrada"]);
  assert.equal(r.arts[0].estado, "vendido"); assert.equal(r.arts[0].fotoVenta, "c1/v.jpg");
});

Deno.test("propias: la última acción queda por defecto (tanda de ventas)", async () => {
  const r = nuevo(12000, null, 0, { etiquetas: "propias", lecturas: [L(5000, "remera blanca"), L(7000, "short jean"), L(5000, "remera blanca"), L(7000, "short jean")] });
  await enviar(r, { foto: "a" }); await enviar(r, { foto: "b" });
  assert.match(await txt(r, { foto: "v1", texto: "vendí" }), /Venta: remera blanca/);
  assert.match(await txt(r, { foto: "v2" }), /Venta: short jean/); // sin decir nada, sigue en ventas
  assert.equal(r.arts.filter((a) => a.estado === "vendido").length, 2);
});

Deno.test("propias: varias al mismo precio → la más parecida, o botones si hay duda", async () => {
  const r = nuevo(12000, null, 0, {
    etiquetas: "propias",
    lecturas: [L(8000, "campera negra"), L(8000, "buzo gris"), L(8000, "jean azul"), L(8000, "buzo gris"), L(8000, "vestido")],
  });
  await enviar(r, { foto: "a" }); await enviar(r, { foto: "b" }); await enviar(r, { foto: "c" });
  const s1 = await enviar(r, { foto: "v1", texto: "vendí" });
  assert.match(s1.respuesta, /Venta: buzo gris/); // se distingue claramente
  const s2 = await enviar(r, { foto: "v2" });
  assert.match(s2.respuesta, /Hay 2 prendas a \$8\.000/);
  assert.deepEqual(s2.botones?.map((b) => b.titulo), ["1 campera negra", "2 jean azul"]);
  assert.match(await txt(r, { texto: "2" }), /Venta: jean azul/);
  assert.equal(r.arts.find((a) => a.descripcion === "jean azul")!.estado, "vendido");
});

Deno.test("propias: venta que era entrada, y entrada que era venta", async () => {
  const r = nuevo(12000, null, 0, { etiquetas: "propias", lecturas: [L(5000, "remera"), L(5000, "remera"), L(5000, "remera")] });
  await enviar(r, { foto: "a" });
  await enviar(r, { foto: "v", texto: "vendí" });
  assert.equal(r.arts[0].estado, "vendido");
  assert.match(await txt(r, { texto: "3" }), /Entrada: remera/); // era una entrada
  assert.equal(r.arts[0].estado, "en_stock"); assert.equal(r.arts.length, 2);
  // Ahora la última acción es «alta»; esta foto era una venta
  await enviar(r, { foto: "v2" });
  assert.equal(r.arts.length, 3);
  // Era una venta: se borra la entrada; quedan dos remeras iguales a $5.000, pregunta cuál
  assert.match(await txt(r, { texto: "1" }), /Hay 2 prendas a \$5\.000/);
  assert.match(await txt(r, { texto: "1" }), /Venta: remera/);
  assert.equal(r.arts.length, 2); // la entrada por error se borró y no cuenta para el cobro
  assert.equal(r.arts.filter((a) => a.estado === "vendido").length, 1);
});

Deno.test("propias: venta para retiro y envío, y pendientes numerados", async () => {
  const r = nuevo(12000, null, 0, { etiquetas: "propias", lecturas: [L(5000, "remera"), L(7000, "short"), L(5000, "remera"), L(7000, "short")] });
  await enviar(r, { foto: "a" }); await enviar(r, { foto: "b" });
  await enviar(r, { foto: "v1", texto: "vendí" });
  assert.match(await txt(r, { texto: "1" }), /reservada para retiro/);
  await enviar(r, { foto: "v2", texto: "vendí" });
  assert.match(await txt(r, { texto: "2" }), /reservada para envío/);
  const p = await enviar(r, { texto: "pendientes" });
  assert.match(p.respuesta, /1 · \*K7M3Q\* · remera · reservada \(retiro en tienda\)/);
  assert.match(p.respuesta, /2 · \*P4XR9\* · short · reservada \(envío\)/);
  const m = await enviar(r, { texto: "2" });
  assert.deepEqual(m.botones?.map((b) => b.titulo), ["1 Salió el envío", "2 Liberar"]);
  assert.match(await txt(r, { texto: "1" }), /en camino/);
  assert.equal(r.arts[1].estado, "en_camino");
});

Deno.test("propias: no encuentra el precio en stock", async () => {
  const r = nuevo(12000, null, 0, { etiquetas: "propias", lecturas: [L(9999, "saco")] });
  assert.match(await txt(r, { foto: "v", texto: "vendí" }), /No encuentro prendas en stock a \$9\.999/);
});

Deno.test("propias: en chino", async () => {
  const r = nuevo(12000, null, 0, { etiquetas: "propias", lecturas: [L(10200, "campera negra", "黑色夹克"), L(10200, "campera negra", "黑色夹克")] });
  const s = await enviar(r, { foto: "a", idioma: "zh" });
  assert.match(s.respuesta, /入库：黑色夹克 · \$10\.200 · ≈0\.85 公斤/);
  assert.deepEqual(s.botones?.map((b) => b.titulo), ["1 其实是卖出", "2 删除"]);
  assert.match(await txt(r, { foto: "v", texto: "卖出", idioma: "zh" }), /卖出：黑色夹克/);
  assert.match(await txt(r, { texto: "帮助", idioma: "zh" }), /拍照管理库存/);
});
