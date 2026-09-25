// Andamio Digital · router del motor común
// Decide a qué módulo va cada mensaje. Es una función pura (sin base de datos)
// para poder probarla sola; index.ts le pasa lo que leyó de Supabase.

import type { Idioma, Modulo } from "./whatsapp.ts";

export const MODULOS: Modulo[] = ["chino", "etiqueta", "turnero", "mermas"];

export const NOMBRE_MODULO: Record<Modulo, Record<Idioma, string>> = {
  chino: { es: "Guías y facturas (Andamio Chino)", zh: "送货单和发票" },
  etiqueta: { es: "Etiquetas de cajas (Etiqueta Visión)", zh: "箱子标签" },
  turnero: { es: "Turnos (Turnero)", zh: "预约" },
  mermas: { es: "Mermas", zh: "损耗" },
};

const PALABRAS_MENU = ["menu", "menú", "hola", "inicio", "ayuda", "菜单", "你好", "帮助"];

export interface Contexto {
  /** Si quien escribe es dueño o empleado de un comercio */
  usuario?: { comercioId: string; idioma: Idioma };
  /** Módulos activos del comercio del usuario */
  modulosActivos: Modulo[];
  /** Sesión vigente (no vencida) de este teléfono */
  sesion?: { modulo?: Modulo | null; paso?: string | null };
  /** Comercios donde este teléfono es cliente (Turnero) */
  comerciosComoCliente: string[];
  texto?: string;
}

export type Decision =
  | { accion: "modulo"; comercioId: string; modulo: Modulo; idioma: Idioma; cambioModulo: boolean }
  | { accion: "menu"; comercioId: string; idioma: Idioma; opciones: Modulo[] }
  | { accion: "sin_modulos"; comercioId: string; idioma: Idioma }
  | { accion: "cliente_turnero"; comercioId: string }
  | { accion: "cliente_ambiguo"; comercioIds: string[] }
  | { accion: "desconocido" };

export function decidir(ctx: Contexto): Decision {
  const texto = (ctx.texto ?? "").trim().toLowerCase();

  // 1) Dueño o empleado de un comercio
  if (ctx.usuario) {
    const { comercioId, idioma } = ctx.usuario;
    const opciones = MODULOS.filter((m) => ctx.modulosActivos.includes(m));
    if (opciones.length === 0) return { accion: "sin_modulos", comercioId, idioma };

    // Está eligiendo del menú: "1", "2"...
    if (ctx.sesion?.paso === "elegir_modulo" && /^\d+$/.test(texto)) {
      const elegido = opciones[Number(texto) - 1];
      if (elegido) {
        return { accion: "modulo", comercioId, modulo: elegido, idioma, cambioModulo: true };
      }
      return { accion: "menu", comercioId, idioma, opciones };
    }

    // Pidió el menú explícitamente y tiene más de un módulo
    if (PALABRAS_MENU.includes(texto) && opciones.length > 1) {
      return { accion: "menu", comercioId, idioma, opciones };
    }

    // Sigue en el módulo de su sesión
    const actual = ctx.sesion?.modulo;
    if (actual && opciones.includes(actual)) {
      return { accion: "modulo", comercioId, modulo: actual, idioma, cambioModulo: false };
    }

    // Un solo módulo contratado: va directo
    if (opciones.length === 1) {
      return { accion: "modulo", comercioId, modulo: opciones[0], idioma, cambioModulo: true };
    }
    return { accion: "menu", comercioId, idioma, opciones };
  }

  // 2) Cliente final de un comercio con Turnero
  if (ctx.comerciosComoCliente.length === 1) {
    return { accion: "cliente_turnero", comercioId: ctx.comerciosComoCliente[0] };
  }
  if (ctx.comerciosComoCliente.length > 1) {
    return { accion: "cliente_ambiguo", comercioIds: ctx.comerciosComoCliente };
  }

  // 3) Número desconocido
  return { accion: "desconocido" };
}

// ---------------------------------------------------------------------------
// Prueba gratuita de 7 días
// ---------------------------------------------------------------------------
export type EstadoComercio = "prueba" | "piloto" | "activo" | "pausado" | "baja";

export interface Acceso {
  habilitado: boolean;
  /** Aviso a agregar a la respuesta (y registrar como enviado) */
  aviso?: "quedan_dias" | "vencida" | "pausado";
  diasRestantes?: number;
}

const DIA = 24 * 3600 * 1000;

/**
 * Decide si el comercio puede usar el bot y si corresponde avisarle.
 * - prueba vigente: habilitado; avisa una vez cuando quedan 2 días o menos
 * - prueba vencida: no habilitado; avisa (como mucho una vez por día)
 * - pausado / baja: no habilitado
 */
export function acceso(
  estado: EstadoComercio,
  pruebaHasta: Date,
  ahora: Date,
  ultimoAviso?: Date | null,
): Acceso {
  if (estado === "piloto" || estado === "activo") return { habilitado: true };
  if (estado === "pausado" || estado === "baja") return { habilitado: false, aviso: "pausado" };

  const restante = pruebaHasta.getTime() - ahora.getTime();
  const diasRestantes = Math.ceil(restante / DIA);
  if (restante <= 0) {
    const avisarDeNuevo = !ultimoAviso || ahora.getTime() - ultimoAviso.getTime() >= DIA ||
      ultimoAviso.getTime() < pruebaHasta.getTime();
    return { habilitado: false, aviso: avisarDeNuevo ? "vencida" : undefined, diasRestantes: 0 };
  }
  // Aviso de "quedan pocos días": una sola vez, dentro de los últimos 2 días
  const yaAvisado = !!ultimoAviso && ultimoAviso.getTime() >= pruebaHasta.getTime() - 2 * DIA;
  if (diasRestantes <= 2 && !yaAvisado) {
    return { habilitado: true, aviso: "quedan_dias", diasRestantes };
  }
  return { habilitado: true, diasRestantes };
}

export function textoAviso(a: Acceso, idioma: Idioma): string | undefined {
  switch (a.aviso) {
    case "quedan_dias":
      return idioma === "zh"
        ? `⏳ 您的免费试用还剩 ${a.diasRestantes} 天。想继续使用，请回复「继续」，我们会联系您。`
        : `⏳ Te ${a.diasRestantes === 1 ? "queda 1 día" : `quedan ${a.diasRestantes} días`} de prueba gratis. Si querés seguir usándolo, respondé «seguir» y te contactamos.`;
    case "vencida":
      return idioma === "zh"
        ? "您的 7 天免费试用已结束。想继续使用，请回复「继续」，我们会联系您。您的数据已保存。"
        : "Terminó tu prueba gratis de 7 días. Si querés seguir usándolo, respondé «seguir» y te contactamos. Tus datos quedan guardados.";
    case "pausado":
      return idioma === "zh"
        ? "您的服务已暂停。如需重新启用，请联系我们。"
        : "Tu servicio está pausado. Si querés reactivarlo, respondé «seguir» y te contactamos.";
  }
}

export function textoMenu(idioma: Idioma, opciones: Modulo[]): string {
  const cab = idioma === "zh" ? "请选择（回复数字）：" : "¿Con qué te ayudo? Respondé con el número:";
  const lineas = opciones.map((m, i) => `${i + 1}. ${NOMBRE_MODULO[m][idioma]}`);
  const pie = idioma === "zh" ? "随时发送「菜单」返回。" : "Escribí «menú» cuando quieras volver acá.";
  return [cab, ...lineas, "", pie].join("\n");
}

export const TEXTOS = {
  desconocido:
    "Hola 👋 Este es el asistente de Andamio Digital. Este número todavía no está registrado. " +
    "Si tenés un comercio y querés probarlo, respondé con tu nombre y el de tu comercio y te contactamos.",
  sinModulos: {
    es: "Tu comercio está registrado pero todavía no tiene módulos activos. Te avisamos cuando esté listo.",
    zh: "您的商店已注册，但尚未启用任何功能。准备好后我们会通知您。",
  },
  clienteAmbiguo:
    "Hola 👋 Tu número figura en más de un comercio. Escribile directamente al local donde querés sacar turno.",
};
