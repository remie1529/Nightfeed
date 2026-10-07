/**
 * Packaged utilityProcess scripts run from app.asar.unpacked. Electron starts
 * that Node environment with kNoGlobalSearchPaths, so NODE_PATH and
 * Module.globalPaths are never searched. Lookup only walks parent folders
 * inside resources/, which finds unpacked webtorrent and then misses
 * dependencies that live in app.asar/node_modules (simple-concat and the rest).
 *
 * Patch Module._nodeModulePaths so a dependency loaded after this runs searches
 * both trees, and push the same folders onto this bundle's module.paths so
 * require() in the entry script itself can see them.
 */
import Module from 'module';
import path from 'path';

const UNPACKED_MARK = `${path.sep}app.asar.unpacked${path.sep}`;

type NodeModulePaths = ((this: unknown, from: string) => string[]) & { __nfPatched?: boolean };

function extraNodeModulePaths(dirname: string): string[] {
  if (!dirname || !dirname.includes(UNPACKED_MARK)) return [];
  // .../resources/app.asar.unpacked/dist-electron → .../resources
  const resourcesDir = path.resolve(dirname, '..', '..');
  return [
    path.join(resourcesDir, 'app.asar.unpacked', 'node_modules'),
    path.join(resourcesDir, 'app.asar', 'node_modules'),
  ];
}

export function patchUtilityModulePaths(dirname: string = typeof __dirname === 'string' ? __dirname : ''): string[] {
  const extra = extraNodeModulePaths(dirname);
  if (!extra.length) return [];

  const own = module.paths;
  if (Array.isArray(own)) {
    for (const p of extra) {
      if (!own.includes(p)) own.push(p);
    }
  }

  const mod = Module as typeof Module & { _nodeModulePaths?: NodeModulePaths };
  const original = mod._nodeModulePaths;
  if (typeof original === 'function' && !original.__nfPatched) {
    const patched: NodeModulePaths = function (this: unknown, from: string) {
      const paths = original.call(this, from).slice();
      for (const p of extra) {
        if (!paths.includes(p)) paths.push(p);
      }
      return paths;
    };
    patched.__nfPatched = true;
    mod._nodeModulePaths = patched;
  }
  return extra;
}

patchUtilityModulePaths();
