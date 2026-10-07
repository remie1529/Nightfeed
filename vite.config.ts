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
                // Run before any hoisted require('webtorrent'). Electron utility
                // processes ignore NODE_PATH and Module.globalPaths
                // (kNoGlobalSearchPaths). Keep this in sync with
                // electron/workers/utility-module-paths.ts.
                intro: `
(function () {
  try {
    var path = require('path');
    var Module = require('module');
    var mark = path.sep + 'app.asar.unpacked' + path.sep;
    if (typeof __dirname !== 'string' || __dirname.indexOf(mark) === -1) return;
    var resourcesDir = path.resolve(__dirname, '..', '..');
    var extra = [
      path.join(resourcesDir, 'app.asar.unpacked', 'node_modules'),
      path.join(resourcesDir, 'app.asar', 'node_modules')
    ];
    if (module && module.paths) {
      extra.forEach(function (p) {
        if (module.paths.indexOf(p) === -1) module.paths.push(p);
      });
    }
    if (typeof Module._nodeModulePaths === 'function' && !Module._nodeModulePaths.__nfPatched) {
      var original = Module._nodeModulePaths;
      var patched = function (from) {
        var paths = original.call(this, from).slice();
        extra.forEach(function (p) {
          if (paths.indexOf(p) === -1) paths.push(p);
        });
        return paths;
      };
      patched.__nfPatched = true;
      Module._nodeModulePaths = patched;
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
        entry: 'electron/workers/hunt-worker.ts',
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
        entry: 'electron/workers/log-writer-worker.ts',
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
        entry: 'electron/workers/ftp-worker.ts',
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
        entry: 'electron/workers/backup-worker.ts',
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
        entry: 'electron/workers/livetv-worker.ts',
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
        entry: 'electron/workers/telegram-send-worker.ts',
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
