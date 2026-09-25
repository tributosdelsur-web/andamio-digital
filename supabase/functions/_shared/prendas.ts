// Andamio Digital · Etiqueta Visión, modo «prenda por prenda»
//
// Para tiendas que venden ropa por kilo. Todo por WhatsApp, en español o chino.
//
//   Dos formas de trabajar (comercio_modulos.config.etiquetas):
//
//   «propias» (por defecto) — la tienda sigue igual, con sus etiquetas de precio.
//            ALTA: foto de la prenda con su etiqueta → la IA lee el precio y describe
//            la prenda; el peso se calcula al revés (precio ÷ precio por kilo).
//            VENTA: otra foto → mismo precio en stock; si hay varias, la más parecida
//            o botones para elegir. La última acción queda por defecto (una tanda de
//            altas, una tanda de ventas) y siempre hay un botón para corregir.
//
//   «qr»     — ALTA: foto + peso («0,85», «850 g», «1.7 斤») → el bot manda la
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
//   COBRO    cuota base con prendas incluidas + un monto por prenda extra, según
//            prendas dadas de alta en el mes («uso»).
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
  descripcion?: string | null;
  descripcion_zh?: string | null;
}

export interface Evento {
  evento: EstadoArticulo | "alta" | "correccion";
  entrega?: Entrega | null;
  nota?: string | null;
  created_at: string;
}

export interface Uso {
  altas: number;
  incluidas: number;
  extra: number;
  base: number;
  por_prenda: number;
  techo: number | null;
  cuota: number;
}

export interface Lectura {
  precio: number | null;
  es: string | null;
  zh: string | null;
}

export interface ConfigPrendas {
  precio_kg?: number | null;
  slug?: string | null;
  catalogo_publico?: boolean;
  /** «propias» (por defecto): etiquetas de precio de la tienda · «qr»: etiquetas de Andamio */
  etiquetas?: "propias" | "qr";
}

export interface RepoPrendas {
  config(): Promise<ConfigPrendas>;
  guardarPrecioKg(precio: number): Promise<void>;
  /** Devuelve el primer código de la lista que exista en este comercio */
  buscar(codigos: string[]): Promise<Articulo | null>;
  crear(a: {
    peso_kg: number | null; precio_kg: number | null; fotoPath?: string;
    precio_manual?: number; descripcion?: string | null; descripcion_zh?: string | null;
  }): Promise<Articulo>;
  /** Corrige el precio (y el peso calculado) de una prenda recién cargada */
  corregirPrecio(a: Articulo, precio: number, pesoKg: number | null): Promise<void>;
  /** Borra una prenda cargada por error (no cuenta para el cobro) */
  eliminar(a: Articulo): Promise<void>;
  /** Prendas en stock con ese precio, las más viejas primero */
  candidatos(precio: number): Promise<Articulo[]>;
  cambiarEstado(a: Articulo, estado: EstadoArticulo, o: { entrega?: Entrega | null; foto?: string; nota?: string }): Promise<void>;
  resumen(): Promise<{ en_stock: number; kg: number; valor: number }>;
  pendientes(): Promise<Articulo[]>;
  historial(a: Articulo): Promise<Evento[]>;
  /** Prendas dadas de alta este mes y cuota que corresponde */
  uso(): Promise<Uso>;
  /** Modo «propias»: precio escrito en la etiqueta y descripción de la prenda (IA) */
  leerEtiquetaPrenda?(fotoPath: string): Promise<Lectura | null>;
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
  ayudaPropias: {
    es: "👕 *Inventario con foto*\n" +
      "• *Entrada:* sacale una foto a la prenda con tu etiqueta de precio. Leo el precio y la anoto.\n" +
      "• *Venta:* otra foto de la prenda (o con el texto «vendí»). La saco del stock.\n" +
      "La última acción queda puesta: si mandás varias entradas seguidas, todas son entradas. Siempre te dejo un botón para corregir.\n" +
      "• «pendientes» (retiros y envíos) · «stock» · «precio 12000» (por kilo, para calcular el peso) · «catálogo» · «uso»",
    zh: "👕 *拍照管理库存*\n" +
      "• *入库：*拍一张带价签的衣服照片，我会读取价格并登记。\n" +
      "• *卖出：*再拍一张这件衣服的照片（或附上「卖出」）。我会把它从库存中移除。\n" +
      "会沿用上一次的操作：连续发送入库照片，都会当作入库。每次都有按钮可以更正。\n" +
      "• 「待处理」（取货和配送）·「库存」·「价格 12000」（每公斤，用于计算重量）·「目录」·「用量」",
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

const usd = (n: number) => "USD " + new Intl.NumberFormat("es-AR", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n);
const usdZh = (n: number) => new Intl.NumberFormat("zh-CN", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n) + " 美元";

const desc = (a: Articulo, l: Idioma) => (l === "zh" ? a.descripcion_zh ?? a.descripcion : a.descripcion ?? a.descripcion_zh) ?? null;

function ficha(a: Articulo, l: Idioma) {
  const d = desc(a, l);
  const entrega = a.entrega && a.estado !== "en_stock" ? ` (${ENTREGA_TXT[a.entrega][l]})` : "";
  const nota = a.envio_nota ? ` · ${a.envio_nota}` : "";
  return `*${a.codigo}*${d ? ` · ${d}` : ""} · ${ESTADO_TXT[a.estado][l]}${entrega}${nota}\n` +
    (a.peso_kg != null ? `${kilos(a.peso_kg, l)} · ` : "") + pesos(a.precio);
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
  const cfg = await repo.config();
  const propias = cfg.etiquetas !== "qr";

  // Modo «etiquetas propias»: fotos de alta y venta, y respuestas a sus preguntas
  if (propias) {
    const r = await manejarPropias(repo, l, cfg, { foto, textoCrudo, it, paso, datos });
    if (r) return r;
  }

  // Elección en la lista de pendientes: «2» → ficha y opciones de esa prenda
  const nLista = textoCrudo.trim().match(/^(\d{1,2})$/);
  if (paso === "prenda_lista" && nLista && Array.isArray(datos.codigos)) {
    const cod = (datos.codigos as string[])[Number(nLista[1]) - 1];
    const a = cod ? await repo.buscar([cod]) : null;
    if (a) return menu(a, l);
  }

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
      return { respuesta: (propias ? TXT.ayudaPropias : TXT.ayuda)[l], paso: null, datos: {} };
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
      const lista = ps.slice(0, 30);
      const lineas = lista.map((a, i) => `${i + 1} · ` + ficha(a, l).split("\n")[0]);
      const pie = l === "zh" ? "回复数字查看并标记。" : "Respondé con el número para marcarla.";
      return {
        respuesta: [titulo, ...lineas, "", pie].join("\n"),
        paso: "prenda_lista",
        datos: { ...conservar(datos), codigos: lista.map((a) => a.codigo) },
      };
    }
    case "precio":
      if (!it.monto) return { respuesta: TXT.preguntaPrecio[l], paso: "prenda_precio", datos: {} };
      await repo.guardarPrecioKg(it.monto);
      return { respuesta: TXT.precioGuardado[l](pesos(it.monto)), paso: null, datos: {} };
    case "catalogo": {
      const c = cfg;
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
    const c = cfg;
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

  return { respuesta: (propias ? TXT.ayudaPropias : TXT.ayuda)[l], paso: null, datos: conservar(datos) };
}

async function textoUso(repo: RepoPrendas, l: Idioma): Promise<string> {
  const u = await repo.uso();
  if (l === "zh") {
    return `📈 本月上架：${entero(u.altas)} 件\n` +
      `月费 ${usdZh(u.base)}，包含 ${entero(u.incluidas)} 件` +
      (u.extra ? `\n超出 ${entero(u.extra)} 件 × ${usdZh(u.por_prenda)}` : `，之后每件 ${usdZh(u.por_prenda)}`) +
      `\n本月费用：*${usdZh(u.cuota)}*` + (u.techo ? `（上限 ${usdZh(u.techo)}）` : "");
  }
  return `📈 Este mes: ${entero(u.altas)} prendas dadas de alta\n` +
    `Cuota ${usd(u.base)} con ${entero(u.incluidas)} incluidas` +
    (u.extra ? `\n+ ${entero(u.extra)} extra × ${usd(u.por_prenda)}` : `; después, ${usd(u.por_prenda)} por prenda`) +
    `\nTotal del mes: *${usd(u.cuota)}*` + (u.techo ? ` (tope ${usd(u.techo)})` : "");
}

/** Aviso cuando esta alta es la primera fuera de las incluidas del mes */
async function avisoUso(repo: RepoPrendas, l: Idioma): Promise<string> {
  try {
    const u = await repo.uso();
    if (u.altas !== u.incluidas + 1 || !u.por_prenda) return "";
    return l === "zh"
      ? `\n\n📈 本月已超过包含的 ${entero(u.incluidas)} 件：之后每件 ${usdZh(u.por_prenda)}。`
      : `\n\n📈 Pasaste las ${entero(u.incluidas)} prendas incluidas del mes: desde ahora cada una suma ${usd(u.por_prenda)}.`;
  } catch (_) {
    return ""; // el aviso nunca frena un alta
  }
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

  respuesta += await avisoUso(repo, l);

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
    const nombre = (x: Evento) =>
      x.evento === "alta" ? (l === "zh" ? "上架" : "alta")
      : x.evento === "correccion" ? (l === "zh" ? "更正" : "corrección")
      : ESTADO_TXT[x.evento][l];
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
    reserva_retiro: { es: `⏸️ ${c} reservada para retiro en tienda: ya no aparece en el catálogo. Cuando la retiren, marcala desde «pendientes».`, zh: `⏸️ ${c} 已预留到店取货，目录中不再显示。客人取货时，在「待处理」里标记。` },
    reserva_envio: { es: `⏸️ ${c} reservada para envío. Cuando salga, marcala desde «pendientes» o escribí «envío ${c}» con la empresa o el link de seguimiento.`, zh: `⏸️ ${c} 已预留配送。发货时在「待处理」里标记，或写「发货 ${c}」加快递公司或查询链接。` },
    retirada: { es: `✅ ${c} retirada por el cliente (${pesos(a.precio)}). Venta cerrada.`, zh: `✅ ${c} 客人已取货（${pesos(a.precio)}）。交易完成。` },
    salio_envio: { es: `🛵 ${c} en camino${nota ? ` (${nota})` : ""}. Cuando llegue, marcala desde «pendientes» o escribí «entregado ${c}».`, zh: `🛵 ${c} 配送中${nota ? `（${nota}）` : ""}。送达后在「待处理」里标记，或写「已送达 ${c}」。` },
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

// ---------------------------------------------------------------------------
// Modo «etiquetas propias»: la tienda no cambia nada, solo saca fotos
// ---------------------------------------------------------------------------

type Tipo = "alta" | "venta";
const RECIENTE_MS = 30 * 60 * 1000; // la última acción queda por defecto durante 30 minutos

/** Lo que se conserva de la sesión entre pasos (la última acción) */
function conservar(datos: Record<string, unknown>): Record<string, unknown> {
  return datos.ultima ? { ultima: datos.ultima } : {};
}
const marca = (tipo: Tipo) => ({ ultima: { tipo, at: Date.now() } });

function tipoPorDefecto(datos: Record<string, unknown>): Tipo {
  const u = datos.ultima as { tipo?: Tipo; at?: number } | undefined;
  return u?.tipo && u.at && Date.now() - u.at < RECIENTE_MS ? u.tipo : "alta";
}

/** Un precio escrito solo («10200», «$10.200», «10.200»), no un peso ni un código */
export function precioSuelto(t: string): number | null {
  const s = aAscii(t).trim();
  if (!/^\$?\s*\d[\d.,]*$/.test(s)) return null;
  const limpio = s.replace(/[$\s]/g, "").replace(/,\d{1,2}$/, "");
  const n = Number(limpio.replace(/[.,]/g, ""));
  return Number.isFinite(n) && n >= 100 ? n : null;
}

/** Parecido entre dos descripciones cortas (palabras en común / total) */
export function parecido(a?: string | null, b?: string | null): number {
  const pal = (x?: string | null) =>
    new Set((x ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .split(/[^a-z一-鿿]+/).flatMap((w) => /[一-鿿]/.test(w) ? [...w] : [w])
      .filter((w) => w.length > 2 || /[一-鿿]/.test(w)));
  const A = pal(a), B = pal(b);
  if (!A.size || !B.size) return 0;
  let comun = 0;
  for (const w of A) if (B.has(w)) comun++;
  return comun / Math.min(A.size, B.size); // «campera negra» ≈ «campera negra con capucha»
}

const pesoDesde = (precio: number, precioKg?: number | null) =>
  precioKg ? Math.round((precio / precioKg) * 1000) / 1000 : null;

interface Ctx {
  foto?: string;
  textoCrudo: string;
  it: Interpretado;
  paso: string | null;
  datos: Record<string, unknown>;
}

const POST: Record<Tipo, { es: string; zh: string }[]> = {
  alta: [{ es: "Era una venta", zh: "其实是卖出" }, { es: "Borrar", zh: "删除" }],
  venta: [{ es: "Era retiro", zh: "到店取货" }, { es: "Era envío", zh: "配送" }, { es: "Era una entrada", zh: "其实是入库" }],
};
const botonesPost = (tipo: Tipo, l: Idioma) => POST[tipo].map((b, i) => ({ id: String(i + 1), titulo: `${i + 1} ${b[l]}` }));

async function manejarPropias(repo: RepoPrendas, l: Idioma, cfg: ConfigPrendas, c: Ctx): Promise<SalidaModulo | null> {
  const { foto, textoCrudo, it, paso, datos } = c;
  const digito = textoCrudo.trim().match(/^([1-3])$/)?.[1];
  const precioTexto = precioSuelto(textoCrudo);
  const texto = (k: string) => typeof datos[k] === "string" ? datos[k] as string : null;

  if (!foto) {
    // Botones o corrección después de una entrada o una venta
    if (paso === "foto_post" && texto("codigo") && (digito || precioTexto)) {
      const a = await repo.buscar([texto("codigo")!]);
      if (!a) return null;
      const tipo = datos.tipo as Tipo;
      if (precioTexto) {
        if (tipo === "alta") {
          const peso = pesoDesde(precioTexto, cfg.precio_kg);
          await repo.corregirPrecio(a, precioTexto, peso);
          return {
            respuesta: (l === "zh" ? "✏️ 已更正：" : "✏️ Corregido: ") + lineaPrenda({ ...a, precio: precioTexto, peso_kg: peso }, l),
            botones: botonesPost("alta", l), paso: "foto_post", datos,
          };
        }
        // Venta con precio mal leído: vuelve al stock y buscamos con el precio correcto
        await repo.cambiarEstado(a, "en_stock", { entrega: null });
        return await identificar(repo, l, precioTexto, { es: texto("es"), zh: texto("zh") }, texto("foto") ?? undefined);
      }
      const i = Number(digito) - 1;
      if (tipo === "alta") {
        if (i === 0) { // era una venta: se borra la entrada y se busca la prenda vendida
          await repo.eliminar(a);
          return await identificar(repo, l, a.precio ?? 0, { es: a.descripcion ?? null, zh: a.descripcion_zh ?? null }, texto("foto") ?? undefined);
        }
        if (i === 1) {
          await repo.eliminar(a);
          return { respuesta: l === "zh" ? "🗑️ 已删除。" : "🗑️ Borrada.", paso: null, datos: conservar(datos) };
        }
      } else {
        if (i === 0 || i === 1) {
          await repo.cambiarEstado(a, "reservado", { entrega: i === 0 ? "retiro" : "envio" });
          const r = i === 0
            ? { es: `⏸️ ${lineaPrenda(a, l)}\nQueda reservada para retiro en tienda. Cuando la retiren, marcala desde «pendientes».`, zh: `⏸️ ${lineaPrenda(a, l)}\n已预留到店取货。客人取货时，在「待处理」里标记。` }
            : { es: `⏸️ ${lineaPrenda(a, l)}\nQueda reservada para envío. Cuando salga, marcala desde «pendientes» (podés sumar la empresa o el link de seguimiento).`, zh: `⏸️ ${lineaPrenda(a, l)}\n已预留配送。发货时在「待处理」里标记（可以附上快递公司或查询链接）。` };
          return { respuesta: r[l], paso: null, datos: conservar(datos) };
        }
        if (i === 2) { // era una entrada: vuelve al stock y se da de alta la prenda nueva
          await repo.cambiarEstado(a, "en_stock", { entrega: null });
          return await altaPropia(repo, l, cfg, a.precio ?? 0, { es: texto("es"), zh: texto("zh") }, texto("foto") ?? undefined);
        }
      }
      return null;
    }

    // Precio que pedimos porque no se pudo leer
    if ((paso === "foto_precio" || paso === "foto_precio_venta") && precioTexto) {
      const lect = { es: texto("es"), zh: texto("zh") };
      return paso === "foto_precio"
        ? await altaPropia(repo, l, cfg, precioTexto, lect, texto("foto") ?? undefined)
        : await identificar(repo, l, precioTexto, lect, texto("foto") ?? undefined);
    }

    // Elección entre varias prendas con el mismo precio
    if (paso === "foto_elegir" && digito && Array.isArray(datos.codigos)) {
      const cod = (datos.codigos as string[])[Number(digito) - 1];
      const a = cod ? await repo.buscar([cod]) : null;
      if (a && a.estado === "en_stock") return await vender(repo, l, a, texto("foto") ?? undefined, { es: texto("es"), zh: texto("zh") });
    }
    return null;
  }

  // Una foto: entrada o venta
  if (it.codigos.length) return null; // trae un código: lo resuelve el flujo general
  const tipo: Tipo = it.accion === "venta" ? "venta" : it.accion === "alta" ? "alta" : tipoPorDefecto(datos);
  const lectura = repo.leerEtiquetaPrenda ? await repo.leerEtiquetaPrenda(foto).catch(() => null) : null;
  const precioPie = (textoCrudo.match(/\$?\s*\d[\d.,]{2,}/g) ?? []).map(precioSuelto).find((n) => n) ?? null;
  const precio = precioPie ?? lectura?.precio ?? null;
  const lect = { es: lectura?.es ?? null, zh: lectura?.zh ?? null };

  if (!precio) {
    const q = tipo === "alta"
      ? { es: "📸 No pude leer el precio de la etiqueta. ¿Cuánto dice? (solo el número)", zh: "📸 看不清价签上的价格。请问是多少？（只发数字）" }
      : { es: "📸 No pude leer el precio de la etiqueta. ¿Cuánto dice? Así busco cuál se vendió.", zh: "📸 看不清价签上的价格。请问是多少？我来查找卖出的是哪一件。" };
    return {
      respuesta: q[l],
      paso: tipo === "alta" ? "foto_precio" : "foto_precio_venta",
      datos: { ...marca(tipo), foto, es: lect.es, zh: lect.zh },
    };
  }
  return tipo === "alta"
    ? await altaPropia(repo, l, cfg, precio, lect, foto)
    : await identificar(repo, l, precio, lect, foto);
}

function lineaPrenda(a: Pick<Articulo, "precio" | "peso_kg" | "descripcion" | "descripcion_zh">, l: Idioma) {
  const d = (l === "zh" ? a.descripcion_zh ?? a.descripcion : a.descripcion ?? a.descripcion_zh) ??
    (l === "zh" ? "衣服" : "prenda");
  return `${d} · ${pesos(a.precio)}` + (a.peso_kg != null ? ` · ≈${kilos(a.peso_kg, l)}` : "");
}

async function altaPropia(
  repo: RepoPrendas, l: Idioma, cfg: ConfigPrendas, precio: number, lect: Omit<Lectura, "precio">, foto?: string,
): Promise<SalidaModulo> {
  const peso = pesoDesde(precio, cfg.precio_kg);
  const a = await repo.crear({
    precio_manual: precio, peso_kg: peso, precio_kg: cfg.precio_kg ?? null,
    descripcion: lect.es, descripcion_zh: lect.zh, fotoPath: foto,
  });
  const r = await repo.resumen();
  const respuesta = (l === "zh"
    ? `📥 入库：${lineaPrenda({ ...a, precio, peso_kg: peso, descripcion: lect.es, descripcion_zh: lect.zh }, l)}\n库存 ${r.en_stock} 件。价格不对的话，直接回复正确的数字。`
    : `📥 Entrada: ${lineaPrenda({ ...a, precio, peso_kg: peso, descripcion: lect.es, descripcion_zh: lect.zh }, l)}\nEn stock: ${r.en_stock}. Si el precio está mal, respondé con el correcto.`) +
    await avisoUso(repo, l);
  return {
    respuesta,
    botones: botonesPost("alta", l),
    paso: "foto_post",
    datos: { ...marca("alta"), codigo: a.codigo, tipo: "alta", foto, es: lect.es, zh: lect.zh },
  };
}

async function identificar(
  repo: RepoPrendas, l: Idioma, precio: number, lect: Omit<Lectura, "precio">, foto?: string,
): Promise<SalidaModulo> {
  const cands = await repo.candidatos(precio);
  if (!cands.length) {
    return {
      respuesta: l === "zh"
        ? `🔎 库存里没有 ${pesos(precio)} 的衣服。如果价格读错了，请回复正确的数字。`
        : `🔎 No encuentro prendas en stock a ${pesos(precio)}. Si leí mal el precio, respondé con el correcto.`,
      paso: "foto_precio_venta",
      datos: { ...marca("venta"), foto, es: lect.es, zh: lect.zh },
    };
  }
  if (cands.length === 1) return await vender(repo, l, cands[0], foto, lect);

  // Varias con el mismo precio: la más parecida, si se distingue claramente
  const puntaje = cands.map((a) => ({
    a, p: Math.max(parecido(lect.es, a.descripcion), parecido(lect.zh, a.descripcion_zh)),
  })).sort((x, y) => y.p - x.p);
  if (puntaje[0].p >= 0.5 && puntaje[0].p - puntaje[1].p >= 0.3) return await vender(repo, l, puntaje[0].a, foto, lect);

  const top = puntaje.slice(0, 3).map((x) => x.a);
  const nombre = (a: Articulo) => (l === "zh" ? a.descripcion_zh ?? a.descripcion : a.descripcion ?? a.descripcion_zh) ?? a.codigo;
  const lineas = top.map((a, i) => `${i + 1} · ${nombre(a)} (${a.codigo})`).join("\n");
  return {
    respuesta: l === "zh"
      ? `🔎 有 ${cands.length} 件 ${pesos(precio)} 的衣服。卖出的是哪一件？\n${lineas}`
      : `🔎 Hay ${cands.length} prendas a ${pesos(precio)}. ¿Cuál se vendió?\n${lineas}`,
    botones: top.map((a, i) => ({ id: String(i + 1), titulo: `${i + 1} ${nombre(a)}`.slice(0, 20) })),
    paso: "foto_elegir",
    datos: { ...marca("venta"), codigos: top.map((a) => a.codigo), foto, es: lect.es, zh: lect.zh },
  };
}

async function vender(
  repo: RepoPrendas, l: Idioma, a: Articulo, foto?: string, lect: Omit<Lectura, "precio"> = { es: null, zh: null },
): Promise<SalidaModulo> {
  await repo.cambiarEstado(a, "vendido", { entrega: "local", foto });
  const r = await repo.resumen();
  return {
    respuesta: l === "zh"
      ? `✅ 卖出：${lineaPrenda(a, l)}\n库存还有 ${r.en_stock} 件。`
      : `✅ Venta: ${lineaPrenda(a, l)}\nQuedan ${r.en_stock} en stock.`,
    botones: botonesPost("venta", l),
    paso: "foto_post",
    datos: { ...marca("venta"), codigo: a.codigo, tipo: "venta", foto, es: lect.es, zh: lect.zh },
  };
}
