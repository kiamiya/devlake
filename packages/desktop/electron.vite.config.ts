import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

/** CSP stricte injectée dans le HTML de production (le serveur de dev a besoin de scripts en ligne). */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function strictCsp(): Plugin {
  return {
    name: 'agentlake-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      ),
  };
}

// Les paquets du monorepo sont intégrés au bundle ; better-sqlite3 (natif) reste externe.
const bundled = ['shared', 'github', 'aura-bridge'];

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: bundled },
      rolldownOptions: {
        input: { index: resolve(import.meta.dirname, 'src/main/index.ts') },
        // CommonJS : format le plus compatible avec Electron et Playwright.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rolldownOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        // Un preload en bac à sable doit être en CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    plugins: [react(), tailwindcss(), strictCsp()],
    build: {
      rolldownOptions: {
        input: { index: resolve(import.meta.dirname, 'src/renderer/index.html') },
      },
    },
  },
});
