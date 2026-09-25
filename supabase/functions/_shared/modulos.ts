// Andamio Digital · módulos
// Cada módulo recibe el mensaje ya ruteado y devuelve la respuesta.
// Esta es la versión base del motor: los módulos confirman la recepción y
// dejan guardado el mensaje (con su foto o audio). La lógica de negocio de
// cada piloto (lectura con IA, conciliación, etiquetas, rescate) se agrega
// en las semanas siguientes del plan, módulo por módulo.

import type { Entrante, Idioma, Modulo } from "./whatsapp.ts";

export interface EntradaModulo {
  comercioId: string;
  idioma: Idioma;
  mensaje: Entrante;
  mediaPath?: string;
  sesion: { paso?: string | null; datos: Record<string, unknown> };
}

export interface SalidaModulo {
  respuesta: string;
  /** Nuevo paso y datos de la sesión (null = limpiar paso) */
  paso?: string | null;
  datos?: Record<string, unknown>;
}

type Manejador = (e: EntradaModulo) => Promise<SalidaModulo> | SalidaModulo;

const esMedia = (t: string) => ["image", "document", "audio"].includes(t);

const chino: Manejador = ({ idioma, mensaje }) => {
  if (esMedia(mensaje.tipo)) {
    return {
      respuesta: idioma === "zh"
        ? "📸 已收到。自动识别功能即将启用，照片已保存。"
        : "📸 Recibido. La lectura automática de guías y facturas se activa en los próximos días; la foto ya quedó guardada.",
      paso: "recibido",
    };
  }
  return {
    respuesta: idioma === "zh"
      ? "请发送送货单或发票的照片。"
      : "Mandame la foto de la guía o de la factura.",
  };
};

const etiqueta: Manejador = ({ mensaje }) => {
  if (esMedia(mensaje.tipo)) {
    return {
      respuesta:
        "📦 Recibido. Pronto te devuelvo la etiqueta con QR de esta caja; la foto ya quedó guardada.",
      paso: "recibido",
    };
  }
  return { respuesta: "Mandame una foto del contenido de la caja o un audio contando qué tiene." };
};

const turnero: Manejador = () => ({
  respuesta: "📅 El Turnero está en preparación. Muy pronto vas a poder ver y gestionar tu agenda desde acá.",
});

const mermas: Manejador = ({ mensaje }) => {
  if (esMedia(mensaje.tipo)) {
    return {
      respuesta:
        "🥬 Recibido. Pronto voy a estimar producto y kilos automáticamente; la foto ya quedó guardada.",
      paso: "recibido",
    };
  }
  return { respuesta: "Mandame una foto del cajón o un audio, por ejemplo: «3 kg de tomate, 2 de lechuga»." };
};

export const MANEJADORES: Record<Modulo, Manejador> = { chino, etiqueta, turnero, mermas };

/** Respuesta para clientes finales de un comercio con Turnero */
export const clienteTurnero = (): SalidaModulo => ({
  respuesta: "Hola 👋 Pronto vas a poder sacar, confirmar o cancelar tu turno por acá.",
});
