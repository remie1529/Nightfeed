/**
 * When the utility entry runs from app.asar.unpacked, Node's require walk never
 * enters sibling app.asar/node_modules. WebTorrent itself is unpacked (native
 * deps), but nearly all of its JS dependency tree stays inside the asar — so
 * require('webtorrent') succeeds then crashes on the next import.
 * Push both unpacked + asar node_modules onto Module.globalPaths first.
 */
import Module from 'module';
import path from 'path';

const UNPACKED_MARK = `${path.sep}app.asar.unpacked${path.sep}`;

export function patchUtilityModulePaths(dirname: string = typeof __dirname === 'string' ? __dirname : ''): string[] {
  if (!dirname || !dirname.includes(UNPACKED_MARK)) return [];
  // .../resources/app.asar.unpacked/dist-electron → .../resources
  const resourcesDir = path.resolve(dirname, '..', '..');
  const added: string[] = [];
  for (const p of [
    path.join(resourcesDir, 'app.asar.unpacked', 'node_modules'),
    path.join(resourcesDir, 'app.asar', 'node_modules'),
  ]) {
    if (!Module.globalPaths.includes(p)) {
      Module.globalPaths.push(p);
      added.push(p);
    }
  }
  return added;
}

patchUtilityModulePaths();
