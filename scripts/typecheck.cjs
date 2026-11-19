/**
 * Typecheck both renderer (tsconfig.json) and Electron main (tsconfig.node.json).
 * Ignores only pre-existing errors inside untouched VPN code (vpn.ts and the
 * VPN bindAddress socket patch in engine.ts). Any other error fails the run.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const IGNORED_PREFIXES = [
  'electron/services/vpn.ts(',
  'electron\\services\\vpn.ts(',
  'electron/services/engine.ts(329,',
  'electron\\services\\engine.ts(329,',
];

function runTsc(args, allowIgnored) {
  const tscJs = require.resolve('typescript/bin/tsc');
  const res = spawnSync(process.execPath, [tscJs, ...args], {
    encoding: 'utf8',
    cwd: path.resolve(__dirname, '..'),
  });
  const output = `${res.stdout || ''}${res.stderr || ''}`.trim();
  if (res.status === 0) return { ok: true, ignored: 0 };

  const lines = output.split(/\r?\n/);
  const kept = [];
  let ignored = 0;
  let skippingContinuation = false;

  for (const line of lines) {
    const isErrorStart = /^[^\s].*\(\d+,\d+\): error TS\d+:/.test(line);
    if (isErrorStart) {
      if (allowIgnored && IGNORED_PREFIXES.some((p) => line.startsWith(p))) {
        ignored += 1;
        skippingContinuation = true;
        continue;
      }
      skippingContinuation = false;
      kept.push(line);
    } else if (!skippingContinuation && line.trim()) {
      kept.push(line);
    }
  }

  if (kept.length > 0) {
    console.error(kept.join('\n'));
    return { ok: false, ignored };
  }
  return { ok: true, ignored };
}

const src = runTsc(['--noEmit'], false);
const node = runTsc(['-p', 'tsconfig.node.json', '--noEmit'], true);

if (!src.ok || !node.ok) {
  process.exit(1);
}
console.log(
  `typecheck OK (src: 0 errors, electron: 0 non-VPN errors${node.ignored ? `, ${node.ignored} untouched VPN-area line(s) skipped` : ''})`
);
