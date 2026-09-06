import path from 'path';
import fs from 'fs';

/**
 * Resolve a file next to the main bundle, preferring asar.unpacked when packaged
 * (worker_threads / utilityProcess cannot execute scripts from inside asar).
 * Electron's fs.existsSync may report asar paths as existing — always prefer unpacked.
 */
export function resolveDistElectronAsset(filename: string): string {
  const direct = path.join(__dirname, filename);
  const asarMarker = `${path.sep}app.asar${path.sep}`;
  if (direct.includes(asarMarker)) {
    const unpacked = direct.replace(asarMarker, `${path.sep}app.asar.unpacked${path.sep}`);
    if (fs.existsSync(unpacked)) return unpacked;
  }
  if (fs.existsSync(direct)) return direct;
  return direct;
}
