// Andamio Digital · Etiqueta Visión, modo «prenda por prenda»
//
// Para tiendas que venden ropa por kilo. Todo por WhatsApp, en español o chino:
//   ALTA   foto de la prenda + peso («0,85», «850 g», «1.7 斤») → código de 5
//          caracteres para escribir en la etiqueta. Queda en stock y en el catálogo.
//   VENTA  foto de la etiqueta (el bot intenta leer el código) o «vendí K7M3Q».
//   OTROS  «stock», «precio 12000» (por kilo), «catálogo», «deshacer K7M3Q»,
//          «baja K7M3Q», «reservar K7M3Q», «ayuda».
//
// La lógica no toca la base directamente: usa un RepoPrendas, así se prueba
// sin Supabase (ver tests/prendas_test.ts) y la versión real está en
// prendas_repo.ts.

import type { Idioma } from "./whatsapp.ts";
import type { EntradaModulo, SalidaModulo } from "./modulos.ts";

export type EstadoArticulo = "en_stock" | "reservado" | "vendido" | "baja";

export interface Articulo {
  id: string;
  codigo: string;
  estado: EstadoArticulo;
  peso_kg: number | null;
  precio: number | null;
}

export interface RepoPrendas {
  config(): Promise<{ precio_kg?: number | null; slug?: string | null; catalogo_publico?: boolean }>;
  guardarPrecioKg(precio: number): Promise<void>;
  /** Devuelve el primer código de la lista que exista en este comercio */
  buscar(codigos: string[]): Promise<Articulo | null>;
  crear(a: { peso_kg: number; precio_kg: number; fotoPath?: string }): Promise<Articulo>;
  cambiarEstado(id: string, estado: EstadoArticulo, fotoVentaPath?: string): Promise<void>;
  resumen(): Promise<{ en_stock: number; kg: number; valor: number }>;
  /** Lectura del código en la foto de la etiqueta (IA). null si no se pudo. */
  leerCodigoEnFoto?(fotoPath: string): Promise<string | null>;
  /** Dirección pública del catálogo, si el comercio lo tiene habilitado */
  urlCatalogo?(slug: string): string;
}

// ---------------------------------------------------------------------------
// Interpretación del texto
// ---------------------------------------------------------------------------

export type Accion =
  | "alta" | "venta" | "deshacer" | "baja" | "reservar"
  | "stock" | "precio" | "catalogo" | "ayuda";

export interface Interpretado {
  accion?: Accion;
  codigos: string[];
  pesoKg?: number;
  monto?: number;
}

// Mismo alfabeto que nuevo_codigo_articulo() en la base: sin 0/O ni 1/I/L
const RE_CODIGO = /(?<![A-Z0-9])[2-9A-HJKMNP-Z]{5}(?![A-Z0-9])/g;

const PALABRAS: [Accion, RegExp][] = [
  ["deshacer", /deshac|devol|volvi[oó]|anular|撤销|退回|恢复|取消/i],
  ["venta", /vend[ií]|venta|vendid|sold|卖出|已售|售出|卖了|已卖/i],
  ["baja", /\bbaja\b|eliminar|borrar|下架|删除/i],
  ["reservar", /reserv|预留|预定|保留/i],
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
    const sinCodigos = codigos.reduce((acc, c) => acc.replace(new RegExp(c, "i"), " "), t);
    const p = peso(sinCodigos);
    if (p !== undefined) r.pesoKg = p;
  }
  return r;
}

// ---------------------------------------------------------------------------
// Textos
// ---------------------------------------------------------------------------

const pesos = (n: number | null | undefined) =>
  n == null ? "—" : "$" + new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(n);
const kilos = (n: number | null | undefined, l: Idioma) =>
  n == null ? "—" : new Intl.NumberFormat(l === "zh" ? "zh-CN" : "es-AR", { maximumFractionDigits: 3 }).format(n) + (l === "zh" ? " 公斤" : " kg");

export const TXT = {
  ayuda: {
    es: "👕 *Prenda por prenda*\n" +
      "• *Alta:* mandá la foto de la prenda con el peso (ej. «0,85» o «850 g»). Te devuelvo el código para la etiqueta.\n" +
      "• *Venta:* mandá la foto de la etiqueta o escribí «vendí» y el código.\n" +
      "• «stock» · «precio 12000» (por kilo) · «catálogo» · «deshacer CÓDIGO» · «baja CÓDIGO» · «reservar CÓDIGO»",
    zh: "👕 *单件管理*\n" +
      "• *上架：*发送衣服照片并写上重量（例如「0.85」或「850克」），我会回复标签编号。\n" +
      "• *卖出：*发送标签照片，或写「卖出」加编号。\n" +
      "• 「库存」·「价格 12000」（每公斤）·「目录」·「撤销 编号」·「下架 编号」·「预留 编号」",
  },
  preguntaPeso: {
    es: "📸 Foto recibida. ¿Cuánto pesa? (ej. «0,85» o «850 g»)\nSi es una *venta*, mandame el código de la etiqueta.",
    zh: "📸 已收到照片。请问重量是多少？（例如「0.85」或「850克」）\n如果是*卖出*，请发送标签上的编号。",
  },
  preguntaPrecio: {
    es: "¿A cuánto vendés el kilo? Mandame solo el número (ej. «12000»). Lo guardo para las próximas.",
    zh: "每公斤卖多少钱？请只发数字（例如「12000」），以后会自动使用。",
  },
  pedirCodigo: {
    es: "¿Qué código tiene la etiqueta? Son 5 letras y números (ej. K7M3Q).",
    zh: "标签上的编号是什么？共 5 个字母和数字（例如 K7M3Q）。",
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
};

const altaOk = (a: Articulo, l: Idioma, sinFoto: boolean) =>
  l === "zh"
    ? `🏷️ 编号：*${a.codigo}*\n${kilos(a.peso_kg, l)} · ${pesos(a.precio)}\n请把编号写在标签上。` +
      (sinFoto ? "\n（没有照片，目录里不会显示图片。）" : "")
    : `🏷️ Código: *${a.codigo}*\n${kilos(a.peso_kg, l)} · ${pesos(a.precio)}\nEscribilo en la etiqueta.` +
      (sinFoto ? "\n(Sin foto: en el catálogo no va a tener imagen.)" : "");

const ESTADO_TXT: Record<EstadoArticulo, { es: string; zh: string }> = {
  en_stock: { es: "en stock", zh: "有货" },
  reservado: { es: "reservada", zh: "已预留" },
  vendido: { es: "vendida", zh: "已售出" },
  baja: { es: "dada de baja", zh: "已下架" },
};

// ---------------------------------------------------------------------------
// Manejador
// ---------------------------------------------------------------------------

type Pendiente = "venta" | "deshacer" | "baja" | "reservar";

export async function manejarPrendas(e: EntradaModulo, repo: RepoPrendas): Promise<SalidaModulo> {
  const l = e.idioma;
  const esFoto = e.mensaje.tipo === "image" || (e.mensaje.tipo === "document" && /^image\//.test(e.mensaje.mimeType ?? ""));
  const foto = esFoto ? e.mediaPath : undefined;
  const it = interpretar(e.mensaje.texto);
  const paso = e.sesion.paso ?? null;
  const datos = e.sesion.datos ?? {};
  const fotoPrevia = typeof datos.foto === "string" ? datos.foto : undefined;

  // Respuesta al pedido de precio por kilo
  if (paso === "prenda_precio" && (it.accion === undefined || it.accion === "precio")) {
    const n = it.monto ?? numero(aAscii(e.mensaje.texto ?? "").replace(/[^\d.,]/g, ""));
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
      return await porCodigo(repo, l, it.accion, it.codigos, foto);
  }

  // Un código suelto, respondiendo a una pregunta nuestra
  if (it.codigos.length && (paso === "prenda_foto" || paso === "prenda_codigo")) {
    const accion = (typeof datos.accion === "string" ? datos.accion : "venta") as Pendiente;
    return await porCodigo(repo, l, accion, it.codigos, foto ?? fotoPrevia);
  }

  // Alta: hay peso (en el texto o en el pie de foto)
  if (it.pesoKg !== undefined && !it.codigos.length) {
    const fotoAlta = foto ?? (paso === "prenda_foto" ? fotoPrevia : undefined);
    const c = await repo.config();
    if (!c.precio_kg) {
      return { respuesta: TXT.preguntaPrecio[l], paso: "prenda_precio", datos: { peso: it.pesoKg, foto: fotoAlta } };
    }
    return await alta(repo, l, it.pesoKg, c.precio_kg, fotoAlta);
  }

  // Código suelto sin contexto: mostramos la ficha
  if (it.codigos.length) {
    const a = await repo.buscar(it.codigos);
    if (!a) return { respuesta: TXT.noExiste[l](it.codigos[0]) };
    return {
      respuesta: `${a.codigo} · ${ESTADO_TXT[a.estado][l]} · ${kilos(a.peso_kg, l)} · ${pesos(a.precio)}` +
        (l === "zh" ? `\n卖出请写「卖出 ${a.codigo}」。` : `\nPara venderla: «vendí ${a.codigo}».`),
    };
  }

  // Foto sin peso: puede ser una etiqueta (venta) o una prenda nueva
  if (foto) {
    if (repo.leerCodigoEnFoto) {
      const leido = await repo.leerCodigoEnFoto(foto).catch(() => null);
      if (leido) {
        const a = await repo.buscar([leido]);
        if (a && a.estado !== "vendido" && a.estado !== "baja") {
          return await aplicar(repo, l, "venta", a, foto);
        }
      }
    }
    return { respuesta: TXT.preguntaPeso[l], paso: "prenda_foto", datos: { foto } };
  }

  return { respuesta: TXT.ayuda[l], paso: null, datos: {} };
}

async function alta(repo: RepoPrendas, l: Idioma, pesoKg: number, precioKg: number, fotoPath?: string): Promise<SalidaModulo> {
  const a = await repo.crear({ peso_kg: pesoKg, precio_kg: precioKg, fotoPath });
  return { respuesta: altaOk(a, l, !fotoPath), paso: null, datos: {} };
}

async function porCodigo(repo: RepoPrendas, l: Idioma, accion: Pendiente, codigos: string[], foto?: string): Promise<SalidaModulo> {
  if (!codigos.length && accion === "venta" && foto && repo.leerCodigoEnFoto) {
    const leido = await repo.leerCodigoEnFoto(foto).catch(() => null);
    if (leido) codigos = [leido];
  }
  if (!codigos.length) {
    return { respuesta: TXT.pedirCodigo[l], paso: "prenda_codigo", datos: { accion, foto } };
  }
  const a = await repo.buscar(codigos);
  if (!a) return { respuesta: TXT.noExiste[l](codigos[0]), paso: "prenda_codigo", datos: { accion, foto } };
  return await aplicar(repo, l, accion, a, foto);
}

async function aplicar(repo: RepoPrendas, l: Idioma, accion: Pendiente, a: Articulo, foto?: string): Promise<SalidaModulo> {
  const destino: EstadoArticulo = accion === "venta" ? "vendido"
    : accion === "baja" ? "baja"
    : accion === "reservar" ? "reservado"
    : "en_stock";
  if (a.estado === destino) {
    return {
      respuesta: l === "zh" ? `${a.codigo} 已经是「${ESTADO_TXT[destino].zh}」。` : `${a.codigo} ya está ${ESTADO_TXT[destino].es}.`,
      paso: null, datos: {},
    };
  }
  if (accion === "venta" && a.estado === "baja") {
    return {
      respuesta: l === "zh" ? `${a.codigo} 已下架。如需恢复请写「撤销 ${a.codigo}」。` : `${a.codigo} está dada de baja. Para recuperarla: «deshacer ${a.codigo}».`,
      paso: null, datos: {},
    };
  }
  await repo.cambiarEstado(a.id, destino, accion === "venta" ? foto : undefined);
  const r = await repo.resumen();
  const quedan = l === "zh" ? `库存还有 ${r.en_stock} 件。` : `Quedan ${r.en_stock} en stock.`;
  const txt = {
    vendido: { es: `✅ ${a.codigo} vendida (${pesos(a.precio)}). ${quedan}\nSi fue un error: «deshacer ${a.codigo}».`, zh: `✅ ${a.codigo} 已卖出（${pesos(a.precio)}）。${quedan}\n如有错误请写「撤销 ${a.codigo}」。` },
    baja: { es: `🗑️ ${a.codigo} dada de baja. ${quedan}`, zh: `🗑️ ${a.codigo} 已下架。${quedan}` },
    reservado: { es: `⏸️ ${a.codigo} reservada: no aparece en el catálogo. Para liberarla: «deshacer ${a.codigo}».`, zh: `⏸️ ${a.codigo} 已预留，目录中不再显示。恢复请写「撤销 ${a.codigo}」。` },
    en_stock: { es: `↩️ ${a.codigo} volvió al stock. ${quedan}`, zh: `↩️ ${a.codigo} 已恢复为有货。${quedan}` },
  }[destino][l];
  return { respuesta: txt, paso: null, datos: {} };
}
