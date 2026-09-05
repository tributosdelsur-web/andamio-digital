# Andamio Digital — sitio y materiales

Carpeta lista para subir a GitHub y publicar en Netlify o Vercel. Son archivos estáticos (HTML), no necesitan build.

## Estructura

```
andamio-digital/
├── index.html            → sitio principal (los 3 pilotos, contacto)
├── vendedores.html        → página de reclutamiento de agentes de territorio
├── evaluacion.html         → lectura + examen de 30 preguntas (90 min) + panel admin
├── assets/                 → logo (blanco, navy, ícono)
├── docs/                   → PDFs descargables
├── supabase/schema.sql     → SQL para crear la tabla de respuestas del examen
└── README.md               → este archivo
```

## Paso 0 — Conectar la base de datos (Supabase)

Ya está hecho: `evaluacion.html` tiene cargadas la URL y la clave "publishable" de tu proyecto de Supabase (`Andamio-Digital`). Si en algún momento creás un proyecto nuevo, repetí esto:

1. [supabase.com](https://supabase.com) → "New project" → SQL Editor → New query → pegá `supabase/schema.sql` → Run.
2. Project Settings → API Keys → copiá **Project URL** y **Publishable key** (`sb_publishable_...`).
3. Abrí `evaluacion.html`, buscá `SUPABASE_URL` y `SUPABASE_ANON_KEY` cerca del final del archivo, y reemplazá los valores.

## Paso 1 — Subir a GitHub (desde la terminal)

```bash
cd ~/Downloads
unzip andamio-digital.zip
mv andamio-digital ~/Desktop/andamio-digital
cd ~/Desktop/andamio-digital

git init
git add .
git commit -m "Sitio Andamio Digital"
git branch -M main
git remote add origin https://github.com/tributosdelsur-web/andamio-digital.git
git push -u origin main
```

## Paso 2 — Publicar (Netlify o Vercel)

**Vercel (terminal):**
```bash
npm install -g vercel
vercel login
vercel
```
Aceptá los valores por defecto (sin build command, sitio estático). Para la versión "oficial": `vercel --prod`.

**Vercel (web, conecta con GitHub, se actualiza solo):**
[vercel.com/new](https://vercel.com/new) → Import → elegí `andamio-digital` → Deploy.

**Netlify (arrastrando la carpeta, rápido):**
[app.netlify.com/drop](https://app.netlify.com/drop) → arrastrá la carpeta `andamio-digital`.

## Notas

- Los links entre páginas son relativos — funcionan igual en local, GitHub Pages, Netlify o Vercel.
- El WhatsApp de contacto (+56 9 5253 2739) está en el header, el footer, la página de vendedores y la sección de contacto.
- El panel admin de `evaluacion.html` (botón "Ver panel admin") lee de Supabase — cualquiera con el link puede ver las respuestas guardadas. Si eso deja de ser aceptable, avisá para sumar un login simple.
- Las secciones de "Servicios de 3 capas" y "Portfolio" (sitios/apps a medida, casos como Compás/OLIVIA) están comentadas dentro de `index.html`, no borradas — el sitio hoy está enfocado 100% en los 3 pilotos de microautomatización. Para reactivarlas, buscá los bloques `<!-- OCULTO POR AHORA ... -->` en el código y sacá el comentario.
