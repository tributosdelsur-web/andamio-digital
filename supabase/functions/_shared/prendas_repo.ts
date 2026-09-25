// Andamio Digital · RepoPrendas sobre Supabase (tabla articulos, buckets wa-media y catalogo)

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Articulo, EstadoArticulo, RepoPrendas } from "./prendas.ts";
import { leerCodigoEtiqueta } from "./ia.ts";

const CAMPOS = "id, codigo, estado, peso_kg, precio";

export function repoPrendas(db: SupabaseClient, comercioId: string, mensajeId?: string): RepoPrendas {
  const leerFoto = async (path: string) => {
    const { data, error } = await db.storage.from("wa-media").download(path);
    if (error || !data) throw error ?? new Error("sin foto");
    return new Uint8Array(await data.arrayBuffer());
  };

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
      // Respeta el orden en que aparecieron en el mensaje
      for (const c of codigos) {
        const a = (data ?? []).find((x) => x.codigo === c.toUpperCase());
        if (a) return a as Articulo;
      }
      return null;
    },

    async crear({ peso_kg, precio_kg, fotoPath }) {
      const { data, error } = await db.from("articulos")
        .insert({ comercio_id: comercioId, peso_kg, precio_kg, alta_mensaje_id: mensajeId ?? null })
        .select(CAMPOS).single();
      if (error) throw error;
      const a = data as Articulo;
      // La foto pasa del bucket privado al público del catálogo
      if (fotoPath) {
        try {
          const bytes = await leerFoto(fotoPath);
          const ext = fotoPath.split(".").pop() || "jpg";
          const destino = `${comercioId}/${a.codigo}.${ext}`;
          const { error: e2 } = await db.storage.from("catalogo")
            .upload(destino, bytes, { contentType: ext === "png" ? "image/png" : "image/jpeg", upsert: true });
          if (!e2) await db.from("articulos").update({ foto_path: destino }).eq("id", a.id);
          else console.error("No se pudo copiar la foto al catálogo", e2);
        } catch (e) {
          console.error("No se pudo copiar la foto al catálogo", e);
        }
      }
      return a;
    },

    async cambiarEstado(id, estado: EstadoArticulo, fotoVentaPath) {
      const cambios: Record<string, unknown> = { estado };
      if (estado === "vendido") {
        cambios.vendido_at = new Date().toISOString();
        cambios.venta_mensaje_id = mensajeId ?? null;
        if (fotoVentaPath) cambios.venta_foto_path = fotoVentaPath;
      } else {
        cambios.vendido_at = null;
      }
      const { error } = await db.from("articulos").update(cambios).eq("id", id).eq("comercio_id", comercioId);
      if (error) throw error;
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

    async leerCodigoEnFoto(path) {
      return await leerCodigoEtiqueta(await leerFoto(path));
    },

    // CATALOGO_URL = dirección de catalogo.html en el sitio (se define al publicarlo)
    urlCatalogo: Deno.env.get("CATALOGO_URL")
      ? (slug: string) => `${Deno.env.get("CATALOGO_URL")}?c=${encodeURIComponent(slug)}`
      : undefined,
  };
}
