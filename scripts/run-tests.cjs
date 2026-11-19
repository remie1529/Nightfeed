/**
 * Compile tests/*.test.ts with esbuild (from Vite) and run them with node --test.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const esbuild = require('esbuild');

const rootDir = path.resolve(__dirname, '..');
const testsDir = path.join(rootDir, 'tests');

if (!fs.existsSync(testsDir)) {
  console.error('No tests directory found');
  process.exit(1);
}

const testFiles = fs
  .readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.ts') || f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join(testsDir, f));

if (!testFiles.length) {
  console.error('No test files found in tests/');
  process.exit(1);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightfeed-tests-'));

async function main() {
  try {
    const built = [];
    for (const entry of testFiles) {
      const outFile = path.join(tmpDir, `${path.basename(entry, path.extname(entry))}.cjs`);
      await esbuild.build({
        entryPoints: [entry],
        outfile: outFile,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        external: ['electron', 'electron-store', 'webtorrent', 'parse-torrent', 'basic-ftp', 'koffi'],
        sourcemap: 'inline',
      });
      built.push(outFile);
    }

    const nodeModules = path.join(rootDir, 'node_modules');
    const env = {
      ...process.env,
      NODE_PATH: process.env.NODE_PATH
        ? `${nodeModules}${path.delimiter}${process.env.NODE_PATH}`
        : nodeModules,
    };
    const res = spawnSync(process.execPath, ['--test', ...built], {
      stdio: 'inherit',
      cwd: rootDir,
      env,
    });
    process.exitCode = res.status ?? 1;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
