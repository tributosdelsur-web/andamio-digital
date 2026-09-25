// Andamio Digital · Etiqueta Visión, modo «prenda por prenda»
//
// Para tiendas que venden ropa por kilo. Todo por WhatsApp, en español o chino.
//
//   ALTA     foto de la prenda + peso («0,85», «850 g», «1.7 斤») → el bot manda la
//            etiqueta con QR y código para imprimir. Queda en stock y en el catálogo.
//   ESCANEO  el QR abre WhatsApp con el código escrito; al mandarlo, el bot ofrece
//            el paso siguiente según el estado de la prenda:
//              en stock   → vendida en el local · reservar para retiro · para envío
//              reservada  → la retiraron / salió el envío · liberar
//              en camino  → entregada · volvió a la tienda
//              vendida    → ver historial · deshacer
//            Los envíos los hace la tienda con la empresa que ya usa; acá solo se
//            registra el estado (y una nota: empresa, link de seguimiento, zona).
//   TEXTO    «vendí K7M3Q», «reservar K7M3Q», «envío K7M3Q PedidosYa», «entregado
//            K7M3Q», «deshacer», «baja», «pendientes», «historial K7M3Q», «stock»,
//            «precio 12000», «catálogo», «uso», «ayuda» (y sus equivalentes en chino).
//   TRAMOS   la cuota depende de las prendas dadas de alta en el mes («uso»).
//
// La lógica no toca la base directamente: usa un RepoPrendas (prendas_repo.ts);
// así se prueba sin Supabase (tests/prendas_test.ts).

import type { Idioma } from "./whatsapp.ts";
import type { EntradaModulo, SalidaModulo } from "./modulos.ts";

export type EstadoArticulo = "en_stock" | "reservado" | "en_camino" | "vendido" | "entregado" | "baja";
export type Entrega = "local" | "retiro" | "envio";

export interface Articulo {
  id: string;
  codigo: string;
  estado: EstadoArticulo;
  entrega?: Entrega | null;
  envio_nota?: string | null;
  peso_kg: number | null;
  precio: number | null;
}

export interface Evento {
  evento: EstadoArticulo | "alta";
  entrega?: Entrega | null;
  nota?: string | null;
  created_at: string;
}

export interface Tramo {
  orden: number;
  nombre_es: string;
  nombre_zh: string;
  hasta: number | null;
  cuota_usd: number;
}

export interface RepoPrendas {
  config(): Promise<{ precio_kg?: number | null; slug?: string | null; catalogo_publico?: boolean }>;
  guardarPrecioKg(precio: number): Promise<void>;
  /** Devuelve el primer código de la lista que exista en este comercio */
  buscar(codigos: string[]): Promise<Articulo | null>;
  crear(a: { peso_kg: number; precio_kg: number; fotoPath?: string }): Promise<Articulo>;
  cambiarEstado(a: Articulo, estado: EstadoArticulo, o: { entrega?: Entrega | null; foto?: string; nota?: string }): Promise<void>;
  resumen(): Promise<{ en_stock: number; kg: number; valor: number }>;
  pendientes(): Promise<Articulo[]>;
  historial(a: Articulo): Promise<Evento[]>;
  /** Prendas dadas de alta este mes, tramo que corresponde y todos los tramos */
  uso(): Promise<{ altas: number; tramo: Tramo; tramos: Tramo[] }>;
  /** Genera la etiqueta PNG con QR y devuelve su URL pública */
  etiqueta?(a: Articulo): Promise<string | null>;
  /** Lectura del código en la foto de la etiqueta (IA). null si no se pudo. */
  leerCodigoEnFoto?(fotoPath: string): Promise<string | null>;
  /** Dirección pública del catálogo, si está configurada */
  urlCatalogo?(slug: string): string;
}

// ---------------------------------------------------------------------------
// Interpretación del texto
// ---------------------------------------------------------------------------

export type Accion =
  | "alta" | "venta" | "deshacer" | "baja" | "reservar" | "envio" | "entregado"
  | "pendientes" | "historial" | "stock" | "precio" | "catalogo" | "uso" | "ayuda";

export interface Interpretado {
  accion?: Accion;
  codigos: string[];
  pesoKg?: number;
  monto?: number;
  /** Texto que sobra después del código (ej. empresa o link de seguimiento) */
  nota?: string;
  /** «reservar para envío» */
  paraEnvio?: boolean;
}

// Mismo alfabeto que nuevo_codigo_articulo() en la base: sin 0/O ni 1/I/L
export const RE_CODIGO = /(?<![A-Z0-9])[2-9A-HJKMNP-Z]{5}(?![A-Z0-9])/g;

// El orden importa: gana la primera que coincide
const PALABRAS: [Accion, RegExp][] = [
  ["deshacer", /deshac|devol|volvi[oó]|anular|liberar|撤销|退回|恢复|取消|释放/i],
  ["historial", /historial|trazabilidad|记录|历史/i],
  ["pendientes", /pendiente|por (entregar|enviar)|待处理|待发货|待取/i],
  ["entregado", /entregad|retirad|la retir|lleg[oó]|已送达|已取|送到了|已交付/i],
  ["reservar", /reserv|预留|预定|保留/i],
  ["envio", /env[ií]o|envi[aé]|despach|sali[oó]|发货|已发|配送|快递/i],
  ["venta", /vend[ií]|venta|vendid|sold|卖出|已售|售出|卖了|已卖/i],
  ["baja", /\bbaja\b|eliminar|borrar|下架|删除/i],
  ["uso", /^\s*(uso|tramo|plan|cuota|用量|套餐|费用)\s*$/i],
  ["stock", /\bstock\b|inventario|库存|盘点/i],
  ["precio", /precio|valor del kilo|por kilo|\bkilo a\b|价格|单价|每公斤/i],
  ["catalogo", /cat[aá]logo|目录|商品目录/i],
  ["ayuda", /^\s*(ayuda|help|\?|帮助|说明)\s*$/i],
  ["alta", /\balta\b|nueva prenda|上架|新衣服|新货/i],
];

const aAscii = (t: string) =>
  t.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 48))
    .replace(/[，]/g, ",").replace(/[．。]/g, ".");

/** «12.000» → 12000 · «12000,50» → 12000.5 · «0,85» → 0.85 */
export function numero(t: string): number | undefined {
  const s = t.replace(/\s|\$/g, "");
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) return Number(s.replace(/\./g, "").replace(",", "."));
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ""));
  if (/^\d+([.,]\d+)?$/.test(s)) return Number(s.replace(",", "."));
  return undefined;
}

/** Peso en kilos a partir de «0,85», «0.85 kg», «850 g», «850», «1.7斤», «0.85公斤» */
export function peso(texto: string): number | undefined {
  const t = aAscii(texto).toLowerCase();
  const m = t.match(/(\d+(?:[.,]\d+)?)\s*(kgs?|kilos?|公斤|千克|gr?s?|gramos?|克|斤)?(?![a-z\d])/);
  if (!m) return undefined;
  let v = numero(m[1]);
  if (v === undefined) return undefined;
  const u = m[2] ?? "";
  if (/^(g|gr|grs|gs|gramo|gramos|克)$/.test(u)) v = v / 1000;
  else if (u === "斤") v = v * 0.5;
  else if (!u && v >= 50) {
    if (v > 5000) return undefined; // un número suelto tan grande no es un peso (¿un precio?)
    v = v / 1000; // número suelto grande: gramos
  }
  v = Math.round(v * 1000) / 1000;
  return v > 0.005 && v <= 100 ? v : undefined;
}

export function interpretar(texto: string | undefined): Interpretado {
  const t = aAscii(texto ?? "").trim();
  const codigos = [...new Set((t.toUpperCase().match(RE_CODIGO) ?? []))];
  let accion: Accion | undefined;
  for (const [a, re] of PALABRAS) if (re.test(t)) { accion = a; break; }

  const r: Interpretado = { accion, codigos };
  if (accion === "precio") {
    const m = t.match(/\$?\s*(\d[\d.,]*)/);
    const n = m ? numero(m[1]) : undefined;
    if (n !== undefined && n > 0) r.monto = n;
  } else if (!accion || accion === "alta") {
    // Sin códigos en el texto, un número es el peso
    if (!codigos.length) {
      const p = peso(t);
      if (p !== undefined) r.pesoKg = p;
    }
  }
  if (accion === "reservar" && /env[ií]o|domicilio|配送|快递|发货/i.test(t)) r.paraEnvio = true;
  if (codigos.length) {
    const i = t.toUpperCase().indexOf(codigos[0]);
    const resto = t.slice(i + codigos[0].length).replace(/^[\s,.:;·-]+/, "").trim();
    if (resto.length >= 2) r.nota = resto.slice(0, 300);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Pasos de la operación
// ---------------------------------------------------------------------------

export type Paso =
  | "venta_local" | "reserva_retiro" | "reserva_envio" | "retirada"
  | "salio_envio" | "entregada" | "liberar" | "volvio" | "historial" | "deshacer" | "baja";

const PASOS: Record<Paso, { es: string; zh: string; estado?: EstadoArticulo; entrega?: Entrega | null }> = {
  venta_local: { es: "Vendida en local", zh: "店内已售", estado: "vendido", entrega: "local" },
  reserva_retiro: { es: "Reservar p/ retiro", zh: "预留到店取", estado: "reservado", entrega: "retiro" },
  reserva_envio: { es: "Reservar p/ envío", zh: "预留配送", estado: "reservado", entrega: "envio" },
  retirada: { es: "Ya la retiraron", zh: "客人已取货", estado: "entregado" },
  salio_envio: { es: "Salió el envío", zh: "已发货", estado: "en_camino", entrega: "envio" },
  entregada: { es: "Entregada", zh: "已送达", estado: "entregado" },
  liberar: { es: "Liberar", zh: "取消预留", estado: "en_stock", entrega: null },
  volvio: { es: "Volvió a la tienda", zh: "退回店里", estado: "en_stock", entrega: null },
  deshacer: { es: "Deshacer", zh: "撤销", estado: "en_stock", entrega: null },
  baja: { es: "Dar de baja", zh: "下架", estado: "baja" },
  historial: { es: "Ver historial", zh: "查看记录" },
};

/** Qué se puede hacer con la prenda según su estado (lo que ofrece el escaneo) */
export function opciones(a: Articulo): Paso[] {
  switch (a.estado) {
    case "en_stock": return ["venta_local", "reserva_retiro", "reserva_envio"];
    case "reservado":
      if (a.entrega === "retiro") return ["retirada", "liberar"];
      if (a.entrega === "envio") return ["salio_envio", "liberar"];
      return ["venta_local", "salio_envio", "liberar"];
    case "en_camino": return ["entregada", "volvio"];
    case "vendido": case "entregado": return ["historial", "deshacer"];
    case "baja": return ["deshacer"];
  }
}

/** Traduce un comando de texto al paso que corresponde según el estado */
function pasoDeAccion(accion: Accion, a: Articulo, it: Interpretado): Paso | undefined {
  switch (accion) {
    case "venta":
      if (a.estado === "reservado" && a.entrega === "retiro") return "retirada";
      if (a.estado === "en_camino") return "entregada";
      if (a.estado === "en_stock" || a.estado === "reservado") return "venta_local";
      return undefined;
    case "reservar":
      return a.estado === "en_stock" ? (it.paraEnvio ? "reserva_envio" : "reserva_retiro") : undefined;
    case "envio":
      return a.estado === "en_stock" || a.estado === "reservado" ? "salio_envio" : undefined;
    case "entregado":
      if (a.estado === "reservado" && a.entrega !== "envio") return "retirada";
      if (a.estado === "en_camino" || a.estado === "reservado") return "entregada";
      return undefined;
    case "deshacer":
      return a.estado === "en_stock" ? undefined : "deshacer";
    case "baja":
      return a.estado === "baja" ? undefined : "baja";
    case "historial":
      return "historial";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Textos
// ---------------------------------------------------------------------------

export const pesos = (n: number | null | undefined) =>
  n == null ? "—" : "$" + new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(n);
const kilos = (n: number | null | undefined, l: Idioma) =>
  n == null ? "—" : new Intl.NumberFormat(l === "zh" ? "zh-CN" : "es-AR", { maximumFractionDigits: 3 }).format(n) + (l === "zh" ? " 公斤" : " kg");
const entero = (n: number) => new Intl.NumberFormat("es-AR").format(n);

const ESTADO_TXT: Record<EstadoArticulo, { es: string; zh: string }> = {
  en_stock: { es: "en stock", zh: "有货" },
  reservado: { es: "reservada", zh: "已预留" },
  en_camino: { es: "en camino", zh: "配送中" },
  vendido: { es: "vendida", zh: "已售出" },
  entregado: { es: "entregada", zh: "已交付" },
  baja: { es: "dada de baja", zh: "已下架" },
};
const ENTREGA_TXT: Record<Entrega, { es: string; zh: string }> = {
  local: { es: "en el local", zh: "店内" },
  retiro: { es: "retiro en tienda", zh: "到店取货" },
  envio: { es: "envío", zh: "配送" },
};

export const TXT = {
  ayuda: {
    es: "👕 *Prenda por prenda*\n" +
      "• *Alta:* foto de la prenda con el peso (ej. «0,85» o «850 g»). Te mando la etiqueta con QR para imprimir.\n" +
      "• *Escaneo:* escaneá el QR con la cámara y mandá el mensaje: te ofrezco el paso siguiente (venta, reserva, envío, entrega).\n" +
      "• *Texto:* «vendí K7M3Q» · «reservar K7M3Q» · «envío K7M3Q PedidosYa» · «entregado K7M3Q» · «deshacer K7M3Q»\n" +
      "• «pendientes» · «historial K7M3Q» · «stock» · «precio 12000» · «catálogo» · «uso»",
    zh: "👕 *单件管理*\n" +
      "• *上架：*发送衣服照片并写上重量（例如「0.85」或「850克」），我会发给您带二维码的标签。\n" +
      "• *扫码：*用相机扫描二维码并发送消息，我会提示下一步（卖出、预留、发货、交付）。\n" +
      "• *文字：*「卖出 K7M3Q」·「预留 K7M3Q」·「发货 K7M3Q 快递公司」·「已送达 K7M3Q」·「撤销 K7M3Q」\n" +
      "• 「待处理」·「记录 K7M3Q」·「库存」·「价格 12000」·「目录」·「用量」",
  },
  preguntaPeso: {
    es: "📸 Foto recibida. ¿Cuánto pesa? (ej. «0,85» o «850 g»)\nSi es de una prenda que ya tiene etiqueta, mandame el código.",
    zh: "📸 已收到照片。请问重量是多少？（例如「0.85」或「850克」）\n如果这件已经有标签，请发送编号。",
  },
  preguntaPrecio: {
    es: "¿A cuánto vendés el kilo? Mandame solo el número (ej. «12000»). Lo guardo para las próximas.",
    zh: "每公斤卖多少钱？请只发数字（例如「12000」），以后会自动使用。",
  },
  pedirCodigo: {
    es: "¿Qué código tiene la etiqueta? Son 5 letras y números (ej. K7M3Q). También podés escanear el QR.",
    zh: "标签上的编号是什么？共 5 个字母和数字（例如 K7M3Q）。也可以直接扫描二维码。",
  },
  noExiste: {
    es: (c: string) => `No encuentro el código ${c}. Revisá la etiqueta y volvé a mandarlo.`,
    zh: (c: string) => `找不到编号 ${c}。请检查标签后再发一次。`,
  },
  precioGuardado: {
    es: (p: string) => `✅ Precio por kilo: ${p}. Se usa para las próximas altas.`,
    zh: (p: string) => `✅ 每公斤价格：${p}。之后上架会自动使用。`,
  },
  sinCatalogo: {
    es: "El catálogo en línea todavía no está activado para tu comercio. Te avisamos cuando esté listo.",
    zh: "您的在线目录还没有开通，准备好后会通知您。",
  },
  sinPendientes: {
    es: "No hay reservas ni envíos pendientes. 👌",
    zh: "没有待取货或待送达的订单。👌",
  },
};

const nombreTramo = (t: Tramo, l: Idioma) => (l === "zh" ? t.nombre_zh : t.nombre_es);

function ficha(a: Articulo, l: Idioma) {
  const entrega = a.entrega && a.estado !== "en_stock" ? ` (${ENTREGA_TXT[a.entrega][l]})` : "";
  const nota = a.envio_nota ? ` · ${a.envio_nota}` : "";
  return `*${a.codigo}* · ${ESTADO_TXT[a.estado][l]}${entrega}${nota}\n${kilos(a.peso_kg, l)} · ${pesos(a.precio)}`;
}

function menu(a: Articulo, l: Idioma): SalidaModulo {
  const ops = opciones(a);
  const lineas = ops.map((p, i) => `${i + 1} · ${PASOS[p][l]}`).join("\n");
  const pie = l === "zh" ? "请点按钮或回复数字。" : "Tocá un botón o respondé con el número.";
  return {
    respuesta: `${ficha(a, l)}\n\n${lineas}\n\n${pie}`,
    botones: ops.map((p, i) => ({ id: String(i + 1), titulo: `${i + 1} ${PASOS[p][l]}` })),
    paso: "prenda_menu",
    datos: { codigo: a.codigo },
  };
}

// ---------------------------------------------------------------------------
// Manejador
// ---------------------------------------------------------------------------

export async function manejarPrendas(e: EntradaModulo, repo: RepoPrendas): Promise<SalidaModulo> {
  const l = e.idioma;
  const esFoto = e.mensaje.tipo === "image" || (e.mensaje.tipo === "document" && /^image\//.test(e.mensaje.mimeType ?? ""));
  const foto = esFoto ? e.mediaPath : undefined;
  const textoCrudo = e.mensaje.texto ?? "";
  const it = interpretar(textoCrudo);
  const paso = e.sesion.paso ?? null;
  const datos = e.sesion.datos ?? {};
  const fotoPrevia = typeof datos.foto === "string" ? datos.foto : undefined;

  // Respuesta al menú del escaneo: «1», «2», «3» (o el botón, que manda su número)
  const opcion = textoCrudo.trim().match(/^([1-3])(\D|$)/);
  if (
    paso === "prenda_menu" && opcion && typeof datos.codigo === "string" && !it.codigos.length &&
    (textoCrudo.trim().length === 1 || it.pesoKg === undefined)
  ) {
    const a = await repo.buscar([datos.codigo]);
    if (!a) return { respuesta: TXT.noExiste[l](datos.codigo), paso: null, datos: {} };
    const elegido = opciones(a)[Number(opcion[1]) - 1];
    if (!elegido) return menu(a, l);
    return await ejecutar(repo, l, a, elegido, { foto });
  }

  // Respuesta al pedido de precio por kilo
  if (paso === "prenda_precio" && (it.accion === undefined || it.accion === "precio")) {
    const n = it.monto ?? numero(aAscii(textoCrudo).replace(/[^\d.,]/g, ""));
    if (n && n > 0) {
      await repo.guardarPrecioKg(n);
      const p = typeof datos.peso === "number" ? datos.peso : undefined;
      if (p) return await alta(repo, l, p, n, fotoPrevia);
      return { respuesta: TXT.precioGuardado[l](pesos(n)), paso: null, datos: {} };
    }
    return { respuesta: TXT.preguntaPrecio[l] };
  }

  switch (it.accion) {
    case "ayuda":
      return { respuesta: TXT.ayuda[l], paso: null, datos: {} };
    case "stock": {
      const r = await repo.resumen();
      return {
        respuesta: l === "zh"
          ? `📦 库存：${r.en_stock} 件 · ${kilos(r.kg, l)} · ${pesos(r.valor)}`
          : `📦 En stock: ${r.en_stock} prendas · ${kilos(r.kg, l)} · ${pesos(r.valor)}`,
      };
    }
    case "uso":
      return { respuesta: await textoUso(repo, l) };
    case "pendientes": {
      const ps = await repo.pendientes();
      if (!ps.length) return { respuesta: TXT.sinPendientes[l] };
      const titulo = l === "zh" ? `📋 待处理（${ps.length}）` : `📋 Pendientes (${ps.length})`;
      const lineas = ps.slice(0, 30).map((a) => "• " + ficha(a, l).split("\n")[0]);
      return { respuesta: [titulo, ...lineas].join("\n") };
    }
    case "precio":
      if (!it.monto) return { respuesta: TXT.preguntaPrecio[l], paso: "prenda_precio", datos: {} };
      await repo.guardarPrecioKg(it.monto);
      return { respuesta: TXT.precioGuardado[l](pesos(it.monto)), paso: null, datos: {} };
    case "catalogo": {
      const c = await repo.config();
      if (!c.slug || !c.catalogo_publico || !repo.urlCatalogo) return { respuesta: TXT.sinCatalogo[l] };
      const url = repo.urlCatalogo(c.slug);
      return {
        respuesta: l === "zh"
          ? `🛍️ 您的目录（只显示有货的商品）：\n${url}`
          : `🛍️ Tu catálogo (muestra solo lo que está en stock):\n${url}`,
      };
    }
    case "venta": case "deshacer": case "baja": case "reservar":
    case "envio": case "entregado": case "historial":
      return await porCodigo(repo, l, it.accion, it, foto);
  }

  // Un código suelto respondiendo a una pregunta nuestra (foto sin peso o código pedido)
  if (it.codigos.length && paso === "prenda_codigo" && typeof datos.accion === "string") {
    return await porCodigo(repo, l, datos.accion as Accion, it, foto ?? fotoPrevia);
  }

  // Alta: hay peso (en el texto o en el pie de foto)
  if (it.pesoKg !== undefined) {
    const fotoAlta = foto ?? (paso === "prenda_foto" ? fotoPrevia : undefined);
    const c = await repo.config();
    if (!c.precio_kg) {
      return { respuesta: TXT.preguntaPrecio[l], paso: "prenda_precio", datos: { peso: it.pesoKg, foto: fotoAlta } };
    }
    return await alta(repo, l, it.pesoKg, c.precio_kg, fotoAlta);
  }

  // Escaneo del QR (o código escrito): ficha y paso siguiente
  if (it.codigos.length) {
    const a = await repo.buscar(it.codigos);
    if (!a) return { respuesta: TXT.noExiste[l](it.codigos[0]), paso: null, datos: {} };
    return menu(a, l);
  }

  // Foto sin peso: puede ser una etiqueta o una prenda nueva
  if (foto) {
    if (repo.leerCodigoEnFoto) {
      const leido = await repo.leerCodigoEnFoto(foto).catch(() => null);
      if (leido) {
        const a = await repo.buscar([leido]);
        if (a) return menu(a, l);
      }
    }
    return { respuesta: TXT.preguntaPeso[l], paso: "prenda_foto", datos: { foto } };
  }

  return { respuesta: TXT.ayuda[l], paso: null, datos: {} };
}

async function textoUso(repo: RepoPrendas, l: Idioma): Promise<string> {
  const u = await repo.uso();
  const siguiente = u.tramos.find((t) => t.orden === u.tramo.orden + 1);
  if (l === "zh") {
    return `📈 本月上架：${entero(u.altas)} 件\n档位：${nombreTramo(u.tramo, l)}` +
      (u.tramo.hasta ? `（最多 ${entero(u.tramo.hasta)} 件）` : "") + ` · 每月 ${u.tramo.cuota_usd} 美元` +
      (siguiente && u.tramo.hasta ? `\n再上架 ${entero(u.tramo.hasta - u.altas + 1)} 件进入「${nombreTramo(siguiente, l)}」档。` : "");
  }
  return `📈 Este mes: ${entero(u.altas)} prendas dadas de alta\nTramo ${nombreTramo(u.tramo, l)}` +
    (u.tramo.hasta ? ` (hasta ${entero(u.tramo.hasta)})` : "") + ` · USD ${u.tramo.cuota_usd}/mes` +
    (siguiente && u.tramo.hasta ? `\nCon ${entero(u.tramo.hasta - u.altas + 1)} altas más pasás al tramo ${nombreTramo(siguiente, l)}.` : "");
}

async function alta(repo: RepoPrendas, l: Idioma, pesoKg: number, precioKg: number, fotoPath?: string): Promise<SalidaModulo> {
  const a = await repo.crear({ peso_kg: pesoKg, precio_kg: precioKg, fotoPath });
  const imagen = repo.etiqueta ? await repo.etiqueta(a).catch(() => null) : null;
  let respuesta = l === "zh"
    ? `🏷️ 编号：*${a.codigo}*\n${kilos(a.peso_kg, l)} · ${pesos(a.precio)}\n` +
      (imagen ? "请打印这张标签贴在衣服上。" : "请把编号写在标签上。") +
      (fotoPath ? "" : "\n（没有照片，目录里不会显示图片。）")
    : `🏷️ Código: *${a.codigo}*\n${kilos(a.peso_kg, l)} · ${pesos(a.precio)}\n` +
      (imagen ? "Imprimí esta etiqueta y pegala en la prenda." : "Escribí el código en la etiqueta.") +
      (fotoPath ? "" : "\n(Sin foto: en el catálogo no va a tener imagen.)");

  // Aviso cuando este alta hace pasar al comercio a otro tramo
  try {
    const u = await repo.uso();
    const cruzado = u.tramos.find((t) => t.hasta !== null && t.hasta + 1 === u.altas);
    if (cruzado) {
      respuesta += l === "zh"
        ? `\n\n📈 本月已上架 ${entero(u.altas)} 件，进入「${nombreTramo(u.tramo, l)}」档（每月 ${u.tramo.cuota_usd} 美元）。`
        : `\n\n📈 Llegaste a ${entero(u.altas)} altas este mes: pasás al tramo ${nombreTramo(u.tramo, l)} (USD ${u.tramo.cuota_usd}/mes).`;
    }
  } catch (_) { /* el aviso de tramo nunca frena un alta */ }

  return { respuesta, imagen: imagen ?? undefined, paso: null, datos: {} };
}

async function porCodigo(repo: RepoPrendas, l: Idioma, accion: Accion, it: Interpretado, foto?: string): Promise<SalidaModulo> {
  let codigos = it.codigos;
  if (!codigos.length && foto && repo.leerCodigoEnFoto) {
    const leido = await repo.leerCodigoEnFoto(foto).catch(() => null);
    if (leido) codigos = [leido];
  }
  if (!codigos.length) {
    return { respuesta: TXT.pedirCodigo[l], paso: "prenda_codigo", datos: { accion, foto } };
  }
  const a = await repo.buscar(codigos);
  if (!a) return { respuesta: TXT.noExiste[l](codigos[0]), paso: "prenda_codigo", datos: { accion, foto } };
  const p = pasoDeAccion(accion, a, it);
  if (!p) {
    // No corresponde en este estado: mostramos qué se puede hacer
    const m = menu(a, l);
    m.respuesta = (l === "zh" ? "这一步现在不适用。\n\n" : "Ese paso no corresponde ahora.\n\n") + m.respuesta;
    return m;
  }
  return await ejecutar(repo, l, a, p, { foto, nota: it.nota });
}

async function ejecutar(repo: RepoPrendas, l: Idioma, a: Articulo, p: Paso, o: { foto?: string; nota?: string }): Promise<SalidaModulo> {
  if (p === "historial") {
    const ev = await repo.historial(a);
    const f = new Intl.DateTimeFormat(l === "zh" ? "zh-CN" : "es-AR", {
      timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    const nombre = (x: Evento) => x.evento === "alta" ? (l === "zh" ? "上架" : "alta") : ESTADO_TXT[x.evento][l];
    const lineas = ev.map((x) =>
      `• ${f.format(new Date(x.created_at))} · ${nombre(x)}` +
      (x.entrega && x.evento !== "en_stock" ? ` (${ENTREGA_TXT[x.entrega][l]})` : "") +
      (x.nota ? ` · ${x.nota}` : "")
    );
    return { respuesta: `🧾 ${a.codigo}\n${lineas.join("\n")}`, paso: null, datos: {} };
  }

  const def = PASOS[p];
  const estado = def.estado!;
  // Al reservar sin decir cómo, o al pasar a entregado, se conserva la forma de entrega
  const entrega = def.entrega !== undefined ? def.entrega : a.entrega ?? null;
  const nota = p === "salio_envio" || p === "reserva_envio" ? o.nota : undefined;
  await repo.cambiarEstado(a, estado, {
    entrega,
    foto: estado === "vendido" || estado === "entregado" || estado === "en_camino" ? o.foto : undefined,
    nota,
  });

  const r = await repo.resumen();
  const quedan = l === "zh" ? `库存还有 ${r.en_stock} 件。` : `Quedan ${r.en_stock} en stock.`;
  const c = a.codigo;
  const txt: Record<Paso, { es: string; zh: string }> = {
    venta_local: { es: `✅ ${c} vendida en el local (${pesos(a.precio)}). ${quedan}`, zh: `✅ ${c} 店内已售（${pesos(a.precio)}）。${quedan}` },
    reserva_retiro: { es: `⏸️ ${c} reservada para retiro en tienda: ya no aparece en el catálogo. Cuando la retiren, escaneá el QR otra vez.`, zh: `⏸️ ${c} 已预留到店取货，目录中不再显示。客人取货时请再扫一次二维码。` },
    reserva_envio: { es: `⏸️ ${c} reservada para envío. Cuando salga, escaneá el QR otra vez (o escribí «envío ${c}» y la empresa o el link de seguimiento).`, zh: `⏸️ ${c} 已预留配送。发货时请再扫一次二维码（或写「发货 ${c}」加快递公司或查询链接）。` },
    retirada: { es: `✅ ${c} retirada por el cliente (${pesos(a.precio)}). Venta cerrada.`, zh: `✅ ${c} 客人已取货（${pesos(a.precio)}）。交易完成。` },
    salio_envio: { es: `🛵 ${c} en camino${nota ? ` (${nota})` : ""}. Cuando llegue, escaneá el QR o escribí «entregado ${c}».`, zh: `🛵 ${c} 配送中${nota ? `（${nota}）` : ""}。送达后请扫二维码或写「已送达 ${c}」。` },
    entregada: { es: `✅ ${c} entregada (${pesos(a.precio)}). Venta cerrada.`, zh: `✅ ${c} 已送达（${pesos(a.precio)}）。交易完成。` },
    liberar: { es: `↩️ ${c} liberada: vuelve al stock y al catálogo. ${quedan}`, zh: `↩️ ${c} 已取消预留，重新上架。${quedan}` },
    volvio: { es: `↩️ ${c} volvió a la tienda y al stock. ${quedan}`, zh: `↩️ ${c} 已退回店里，重新上架。${quedan}` },
    deshacer: { es: `↩️ ${c} volvió al stock. ${quedan}`, zh: `↩️ ${c} 已恢复为有货。${quedan}` },
    baja: { es: `🗑️ ${c} dada de baja. ${quedan}`, zh: `🗑️ ${c} 已下架。${quedan}` },
    historial: { es: "", zh: "" },
  };
  const deshacer = estado === "vendido" || estado === "entregado"
    ? (l === "zh" ? `\n如有错误请写「撤销 ${c}」。` : `\nSi fue un error: «deshacer ${c}».`)
    : "";
  return { respuesta: txt[p][l] + deshacer, paso: null, datos: {} };
}
