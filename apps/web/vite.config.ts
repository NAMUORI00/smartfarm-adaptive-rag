import { cpSync, createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// pdf.js reads a PDF's Korean and other CJK fonts through Adobe's character maps, and draws
// standard fonts, scanned images and colour profiles with its own data files. They are served
// from the installed package under /pdfjs/ (and copied into the build), so the original view
// works without the internet.
const PDFJS_DATA = ['cmaps', 'standard_fonts', 'wasm', 'iccs']
const webRoot = fileURLToPath(new URL('.', import.meta.url))
const pdfjsRoot = resolve(webRoot, 'node_modules/pdfjs-dist')
const PDFJS_TYPES: Record<string, string> = { '.wasm': 'application/wasm', '.js': 'text/javascript' }

function pdfjsData(): Plugin {
  return {
    name: 'smartfarm-pdfjs-data',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (request, response, next) => {
        const path = normalize(decodeURIComponent((request.url ?? '').split('?')[0])).replace(/^[/\\]+/, '')
        const [folder] = path.split(/[/\\]/)
        const file = join(pdfjsRoot, path)
        if (!PDFJS_DATA.includes(folder) || !file.startsWith(pdfjsRoot) || !existsSync(file) || !statSync(file).isFile()) return next()
        response.setHeader('Content-Type', PDFJS_TYPES[extname(file)] ?? 'application/octet-stream')
        response.setHeader('Cache-Control', 'public, max-age=86400')
        createReadStream(file).pipe(response)
      })
    },
    writeBundle(options) {
      const out = options.dir ?? resolve(webRoot, 'dist')
      for (const folder of PDFJS_DATA) cpSync(join(pdfjsRoot, folder), join(out, 'pdfjs', folder), { recursive: true })
    },
  }
}

export default defineConfig({
  // The public replay demo is served below the repository's path on GitHub Pages (DEMO_BASE=/<repo>/).
  base: process.env.DEMO_BASE ?? '/',
  plugins: [react(), pdfjsData()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: process.env.SMARTFARM_DEV_API_TARGET ?? 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
