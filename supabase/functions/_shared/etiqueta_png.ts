// Andamio Digital · etiqueta de prenda en PNG: QR grande + código + peso y precio.
// Sin canvas ni fuentes externas (corre en Supabase Edge Functions): el QR sale de
// la librería qrcode y el texto se dibuja con una fuente de mapa de bits 5×7.
// Pensada para impresoras térmicas de etiquetas desde el celular (blanco y negro).

import QRCode from "npm:qrcode@1.5.4";
import { deflateSync } from "node:zlib";

const FUENTE: Record<string, string> = {
  "0": "01110100011001110101110011000101110", "1": "00100011000010000100001000010001110",
  "2": "01110100010000100010001000100011111", "3": "11111000100010000010000011000101110",
  "4": "00010001100101010010111110001000010", "5": "11111100001111000001000011000101110",
  "6": "00110010001000011110100011000101110", "7": "11111000010001000100010000100001000",
  "8": "01110100011000101110100011000101110", "9": "01110100011000101111000010001001100",
  A: "01110100011000111111100011000110001", B: "11110100011000111110100011000111110",
  C: "01110100011000010000100001000101110", D: "11100100101000110001100011001011100",
  E: "11111100001000011110100001000011111", F: "11111100001000011110100001000010000",
  G: "01110100011000010111100011000101111", H: "10001100011000111111100011000110001",
  I: "01110001000010000100001000010001110", J: "00111000100001000010000101001001100",
  K: "10001100101010011000101001001010001", L: "10000100001000010000100001000011111",
  M: "10001110111010110101100011000110001", N: "10001100011100110101100111000110001",
  O: "01110100011000110001100011000101110", P: "11110100011000111110100001000010000",
  Q: "01110100011000110001101011001001101", R: "11110100011000111110101001001010001",
  S: "01111100001000001110000010000111110", T: "11111001000010000100001000010000100",
  U: "10001100011000110001100011000101110", V: "10001100011000110001100010101000100",
  W: "10001100011000110101101011010101010", X: "10001100010101000100010101000110001",
  Y: "10001100011000101010001000010000100", Z: "11111000010001000100010001000011111",
  ",": "00000000000000000000011000010001000", ".": "00000000000000000000000000110001100",
  "$": "00100011111010001110001011111000100", "-": "00000000000000011111000000000000000",
  " ": "00000000000000000000000000000000000",
};

class Lienzo {
  px: Uint8Array;
  constructor(public w: number, public h: number) {
    this.px = new Uint8Array(w * h).fill(255);
  }
  rect(x: number, y: number, w: number, h: number, v = 0) {
    for (let j = Math.max(0, y); j < Math.min(this.h, y + h); j++) {
      this.px.fill(v, j * this.w + Math.max(0, x), j * this.w + Math.min(this.w, x + w));
    }
  }
  /** Texto centrado; escala = tamaño de cada punto de la fuente en píxeles */
  texto(t: string, y: number, escala: number) {
    const chars = [...t.toUpperCase()].filter((c) => FUENTE[c]);
    const ancho = (chars.length * 6 - 1) * escala;
    let x = Math.round((this.w - ancho) / 2);
    for (const c of chars) {
      const g = FUENTE[c];
      for (let f = 0; f < 7; f++) {
        for (let k = 0; k < 5; k++) if (g[f * 5 + k] === "1") this.rect(x + k * escala, y + f * escala, escala, escala);
      }
      x += 6 * escala;
    }
    return 7 * escala;
  }
}

const TABLA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array) {
  let c = 0xFFFFFFFF;
  for (const x of b) c = TABLA_CRC[(c ^ x) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function bloque(tipo: string, datos: Uint8Array) {
  const out = new Uint8Array(12 + datos.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, datos.length);
  out.set(new TextEncoder().encode(tipo), 4);
  out.set(datos, 8);
  dv.setUint32(8 + datos.length, crc32(out.subarray(4, 8 + datos.length)));
  return out;
}
/** PNG en escala de grises, 8 bits */
export function png(l: Lienzo): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, l.w); dv.setUint32(4, l.h);
  ihdr[8] = 8; ihdr[9] = 0; // 8 bits, gris
  const crudo = new Uint8Array((l.w + 1) * l.h);
  for (let y = 0; y < l.h; y++) crudo.set(l.px.subarray(y * l.w, (y + 1) * l.w), y * (l.w + 1) + 1);
  const partes = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    bloque("IHDR", ihdr),
    bloque("IDAT", new Uint8Array(deflateSync(crudo, { level: 9 }))),
    bloque("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(partes.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of partes) { out.set(p, o); o += p.length; }
  return out;
}

export interface DatosEtiqueta {
  codigo: string;
  /** Lo que abre el QR: link de WhatsApp al bot con el código ya escrito */
  contenidoQr: string;
  /** Segunda línea, ej. «0,85 KG  $10.200» */
  detalle?: string;
}

export function etiquetaPng({ codigo, contenidoQr, detalle }: DatosEtiqueta): Uint8Array {
  const qr = QRCode.create(contenidoQr, { errorCorrectionLevel: "M" });
  const n: number = qr.modules.size;
  const W = 480;
  const escala = Math.floor((W - 32) / (n + 8)); // 4 módulos de margen por lado
  const lado = escala * (n + 8);
  const H = lado + 7 * 12 + (detalle ? 16 + 7 * 4 : 0) + 36;
  const l = new Lienzo(W, H);
  const x0 = Math.round((W - lado) / 2) + 4 * escala;
  const y0 = 4 * escala;
  for (let f = 0; f < n; f++) {
    for (let c = 0; c < n; c++) if (qr.modules.get(f, c)) l.rect(x0 + c * escala, y0 + f * escala, escala, escala);
  }
  let y = lado;
  y += l.texto(codigo, y, 12);
  if (detalle) { y += 16; l.texto(detalle, y, 4); }
  return png(l);
}

/** «0,85 KG  $10.200» */
export function detalleEtiqueta(pesoKg: number | null, precio: number | null): string | undefined {
  const partes: string[] = [];
  if (pesoKg != null) partes.push(new Intl.NumberFormat("es-AR", { maximumFractionDigits: 3 }).format(pesoKg) + " KG");
  if (precio != null) partes.push("$" + new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(precio));
  return partes.length ? partes.join("  ") : undefined;
}

/** Link que va en el QR. Sin número del bot, el QR lleva solo el código. */
export function contenidoQr(numeroBot: string | undefined, codigo: string): string {
  const d = (numeroBot ?? "").replace(/\D/g, "");
  return d ? `https://wa.me/${d}?text=${encodeURIComponent(codigo)}` : codigo;
}
