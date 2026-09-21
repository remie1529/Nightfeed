import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import path from 'path'

const electronExternal = ['electron', 'electron-store', 'webtorrent', 'basic-ftp', 'koffi']

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: electronExternal,
            },
          },
        },
      },
      {
        entry: 'electron/workers/search-worker.ts',
        onstart() {
          // Worker rebuild — no Electron restart needed beyond main reload
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            emptyOutDir: false,
            rollupOptions: {
              external: electronExternal,
            },
          },
        },
      },
      {
        entry: 'electron/workers/torrent-utility.ts',
        onstart() {},
        vite: {
          build: {
            outDir: 'dist-electron',
            emptyOutDir: false,
            rollupOptions: {
              external: electronExternal,
              output: {
                // Run before any hoisted require('webtorrent') in the CJS bundle.
                intro: `
(function () {
  try {
    var path = require('path');
    var Module = require('module');
    var mark = path.sep + 'app.asar.unpacked' + path.sep;
    if (typeof __dirname === 'string' && __dirname.indexOf(mark) !== -1) {
      var resourcesDir = path.resolve(__dirname, '..', '..');
      [path.join(resourcesDir, 'app.asar.unpacked', 'node_modules'),
       path.join(resourcesDir, 'app.asar', 'node_modules')].forEach(function (p) {
        if (Module.globalPaths.indexOf(p) === -1) Module.globalPaths.push(p);
      });
    }
  } catch (e) {}
})();`.trim(),
              },
            },
          },
        },
      },
      {
        entry: 'electron/workers/metadata-worker.ts',
        onstart() {},
        vite: {
          build: {
            outDir: 'dist-electron',
            emptyOutDir: false,
            rollupOptions: {
              external: electronExternal,
            },
          },
        },
      },
      {
        entry: 'electron/workers/library-worker.ts',
        onstart() {},
        vite: {
          build: {
            outDir: 'dist-electron',
            emptyOutDir: false,
            rollupOptions: {
              external: electronExternal,
            },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart(args) {
          args.reload()
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            emptyOutDir: false,
          },
        },
      },
    ]),
    renderer(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
  },
  server: {
    port: 5173,
  },
})
