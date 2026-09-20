import path from 'path';
import fs from 'fs';
import { app } from 'electron';

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

/**
 * NODE_PATH entries so a script running from app.asar.unpacked can still
 * require() packages that live only inside app.asar/node_modules (and prefer
 * unpacked natives like utp-native / koffi).
 */
export function packagedNodeModulePaths(): string[] {
  try {
    if (!app?.isPackaged) return [];
  } catch {
    return [];
  }
  const resources = process.resourcesPath;
  if (!resources) return [];
  return [
    path.join(resources, 'app.asar.unpacked', 'node_modules'),
    path.join(resources, 'app.asar', 'node_modules'),
  ];
}

export function buildUtilityProcessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const extra = packagedNodeModulePaths();
  if (!extra.length) return env;
  const parts = [...extra];
  if (env.NODE_PATH) parts.push(env.NODE_PATH);
  env.NODE_PATH = parts.join(path.delimiter);
  return env;
}
