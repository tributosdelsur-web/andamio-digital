// Andamio Digital · RepoPrendas sobre Supabase
// Tablas articulos, articulo_eventos, tramos_prendas; buckets wa-media (privado)
// y catalogo (público: fotos de prendas y etiquetas con QR).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Articulo, Evento, RepoPrendas, Tramo } from "./prendas.ts";
import { pesos, RE_CODIGO } from "./prendas.ts";
import type { SalidaModulo } from "./modulos.ts";
import { leerCodigoEtiqueta } from "./ia.ts";
import { contenidoQr, detalleEtiqueta, etiquetaPng } from "./etiqueta_png.ts";

const CAMPOS = "id, codigo, estado, entrega, envio_nota, peso_kg, precio";

export function repoPrendas(
  db: SupabaseClient,
  comercioId: string,
  o: { mensajeId?: string; telefono?: string; numeroBot?: string } = {},
): RepoPrendas {
  const leerFoto = async (path: string) => {
    const { data, error } = await db.storage.from("wa-media").download(path);
    if (error || !data) throw error ?? new Error("sin foto");
    return new Uint8Array(await data.arrayBuffer());
  };
  const evento = (articuloId: string, e: Record<string, unknown>) =>
    db.from("articulo_eventos").insert({
      articulo_id: articuloId, comercio_id: comercioId,
      telefono: o.telefono ?? null, mensaje_id: o.mensajeId ?? null, ...e,
    }).then(({ error }) => { if (error) console.error("articulo_eventos", error); });

  return {
    async config() {
      const [{ data: mod }, { data: co }] = await Promise.all([
        db.from("comercio_modulos").select("config")
          .eq("comercio_id", comercioId).eq("modulo", "etiqueta").maybeSingle(),
        db.from("comercios").select("slug, catalogo_publico").eq("id", comercioId).maybeSingle(),
      ]);
      const precio = Number(mod?.config?.precio_kg);
      return {
        precio_kg: Number.isFinite(precio) && precio > 0 ? precio : null,
        slug: co?.slug ?? null,
        catalogo_publico: !!co?.catalogo_publico,
      };
    },

    async guardarPrecioKg(precio) {
      const { data: mod } = await db.from("comercio_modulos").select("config")
        .eq("comercio_id", comercioId).eq("modulo", "etiqueta").maybeSingle();
      const config = { ...(mod?.config ?? {}), modo: "prendas", precio_kg: precio };
      const { error } = await db.from("comercio_modulos").update({ config })
        .eq("comercio_id", comercioId).eq("modulo", "etiqueta");
      if (error) throw error;
    },

    async buscar(codigos) {
      if (!codigos.length) return null;
      const { data, error } = await db.from("articulos").select(CAMPOS)
        .eq("comercio_id", comercioId).in("codigo", codigos.map((c) => c.toUpperCase()));
      if (error) throw error;
      for (const c of codigos) {
        const a = (data ?? []).find((x) => x.codigo === c.toUpperCase());
        if (a) return a as Articulo;
      }
      return null;
    },

    async crear({ peso_kg, precio_kg, fotoPath }) {
      const { data, error } = await db.from("articulos")
        .insert({ comercio_id: comercioId, peso_kg, precio_kg, alta_mensaje_id: o.mensajeId ?? null })
        .select(CAMPOS).single();
      if (error) throw error;
      const a = data as Articulo;
      let fotoCatalogo: string | null = null;
      // La foto pasa del bucket privado al público del catálogo
      if (fotoPath) {
        try {
          const bytes = await leerFoto(fotoPath);
          const ext = fotoPath.split(".").pop() || "jpg";
          const destino = `${comercioId}/${a.codigo}.${ext}`;
          const { error: e2 } = await db.storage.from("catalogo")
            .upload(destino, bytes, { contentType: ext === "png" ? "image/png" : "image/jpeg", upsert: true });
          if (!e2) {
            fotoCatalogo = destino;
            await db.from("articulos").update({ foto_path: destino }).eq("id", a.id);
          } else console.error("No se pudo copiar la foto al catálogo", e2);
        } catch (e) {
          console.error("No se pudo copiar la foto al catálogo", e);
        }
      }
      await evento(a.id, { evento: "alta", foto_path: fotoCatalogo });
      return a;
    },

    async cambiarEstado(a, estado, { entrega, foto, nota }) {
      const cambios: Record<string, unknown> = { estado, entrega: entrega ?? null };
      if (nota !== undefined) cambios.envio_nota = nota ?? null;
      if (estado === "en_stock") cambios.envio_nota = null;
      if (estado === "vendido" || estado === "entregado") {
        cambios.venta_mensaje_id = o.mensajeId ?? null;
        if (foto) cambios.venta_foto_path = foto;
      }
      const { error } = await db.from("articulos").update(cambios).eq("id", a.id).eq("comercio_id", comercioId);
      if (error) throw error;
      await evento(a.id, { evento: estado, entrega: entrega ?? null, foto_path: foto ?? null, nota: nota ?? null });
    },

    async resumen() {
      const { data } = await db.from("inventario_prendas")
        .select("en_stock, kg_en_stock, valor_en_stock").eq("comercio_id", comercioId).maybeSingle();
      return {
        en_stock: Number(data?.en_stock ?? 0),
        kg: Number(data?.kg_en_stock ?? 0),
        valor: Number(data?.valor_en_stock ?? 0),
      };
    },

    async pendientes() {
      const { data, error } = await db.from("articulos").select(CAMPOS)
        .eq("comercio_id", comercioId).in("estado", ["reservado", "en_camino"])
        .order("created_at", { ascending: true }).limit(50);
      if (error) throw error;
      return (data ?? []) as Articulo[];
    },

    async historial(a) {
      const { data, error } = await db.from("articulo_eventos")
        .select("evento, entrega, nota, created_at")
        .eq("articulo_id", a.id).order("created_at", { ascending: true }).limit(30);
      if (error) throw error;
      return (data ?? []) as Evento[];
    },

    async uso() {
      const [{ data: u, error }, { data: tramos }] = await Promise.all([
        db.rpc("uso_prendas", { p_comercio: comercioId }).single(),
        db.from("tramos_prendas").select("orden, nombre_es, nombre_zh, hasta, cuota_usd").order("orden"),
      ]);
      if (error || !u) throw error ?? new Error("sin uso");
      // deno-lint-ignore no-explicit-any
      const x = u as any;
      const tramo: Tramo = {
        orden: x.orden, nombre_es: x.nombre_es, nombre_zh: x.nombre_zh,
        hasta: x.hasta, cuota_usd: Number(x.cuota_usd),
      };
      return {
        altas: Number(x.altas),
        tramo,
        tramos: (tramos ?? []).map((t) => ({ ...t, cuota_usd: Number(t.cuota_usd) })) as Tramo[],
      };
    },

    async etiqueta(a) {
      const png = etiquetaPng({
        codigo: a.codigo,
        contenidoQr: contenidoQr(o.numeroBot, a.codigo),
        detalle: detalleEtiqueta(a.peso_kg, a.precio),
      });
      const path = `${comercioId}/etiquetas/${a.codigo}.png`;
      const { error } = await db.storage.from("catalogo")
        .upload(path, png, { contentType: "image/png", upsert: true });
      if (error) {
        console.error("No se pudo guardar la etiqueta", error);
        return null;
      }
      await db.from("articulos").update({ etiqueta_path: path }).eq("id", a.id);
      return db.storage.from("catalogo").getPublicUrl(path).data.publicUrl;
    },

    async leerCodigoEnFoto(path) {
      return await leerCodigoEtiqueta(await leerFoto(path));
    },

    // CATALOGO_URL = dirección de catalogo.html en el sitio (se define al publicarlo)
    urlCatalogo: Deno.env.get("CATALOGO_URL")
      ? (slug: string) => `${Deno.env.get("CATALOGO_URL")}?c=${encodeURIComponent(slug)}`
      : undefined,
  };
}

/**
 * Alguien que no es del comercio escaneó el QR de una prenda (un comprador en la
 * tienda, o alguien que vio la foto): le mostramos la prenda y lo mandamos al
 * WhatsApp de la tienda para pedirla. Devuelve null si el texto no es un código.
 */
export async function fichaComprador(db: SupabaseClient, texto: string | undefined): Promise<SalidaModulo | null> {
  const t = (texto ?? "").trim().toUpperCase();
  const cod = t.match(RE_CODIGO);
  if (!cod || t.length > 12) return null; // solo si mandó el código solo (lo que arma el QR)
  const { data: a } = await db.from("articulos")
    .select("codigo, estado, peso_kg, precio, foto_path, comercios(nombre, telefono_wa, estado)")
    .eq("codigo", cod[0]).maybeSingle();
  // deno-lint-ignore no-explicit-any
  const co = (a as any)?.comercios;
  if (!a || !co || !["prueba", "piloto", "activo"].includes(co.estado)) return null;
  const zh = /[一-鿿]/.test(texto ?? "");
  if (a.estado !== "en_stock") {
    return {
      respuesta: zh
        ? `这件衣服（${a.codigo}）已经售出或被预留了。欢迎看看${co.nombre}的其他商品！`
        : `Esta prenda (${a.codigo}) ya no está disponible. ¡Mirá lo que hay en ${co.nombre}!`,
    };
  }
  const pedido = encodeURIComponent(`Hola, me interesa la prenda ${a.codigo}`);
  const link = co.telefono_wa ? `https://wa.me/${co.telefono_wa}?text=${pedido}` : "";
  const kg = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 3 }).format(Number(a.peso_kg));
  const respuesta = zh
    ? `👕 ${co.nombre} · ${a.codigo}\n${kg} 公斤 · ${pesos(Number(a.precio))}` +
      (link ? `\n\n想要这件？请联系店家（可到店取货或配送）：\n${link}` : "")
    : `👕 ${co.nombre} · ${a.codigo}\n${kg} kg · ${pesos(Number(a.precio))}` +
      (link ? `\n\n¿La querés? Pedila a la tienda (retiro en tienda o envío):\n${link}` : "");
  const imagen = a.foto_path ? db.storage.from("catalogo").getPublicUrl(a.foto_path).data.publicUrl : undefined;
  return { respuesta, imagen };
}
