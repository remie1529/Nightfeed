/**
 * Embed build/icon.ico into the Windows .exe.
 * signAndEditExecutable is false, so without this the taskbar and desktop
 * shortcut keep the default Electron icon. rcedit often fails once with
 * "Unable to commit changes" while the new exe is still locked; retry.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const https = require('https');

const RCEDIT_URL = 'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe';

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(dest);
          return download(res.headers.location, dest).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          reject(new Error(`download failed: ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', reject);
  });
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const projectDir = context.packager.projectDir;
  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exePath = path.join(context.appOutDir, exeName);
  const icoPath = path.join(projectDir, 'build', 'icon.ico');
  const cacheDir = path.join(projectDir, 'scripts', '.cache');
  const rceditPath = path.join(cacheDir, 'rcedit-x64.exe');

  if (!fs.existsSync(exePath)) {
    console.warn('[after-pack-icon] exe not found:', exePath);
    return;
  }
  if (!fs.existsSync(icoPath)) {
    console.warn('[after-pack-icon] icon.ico not found:', icoPath);
    return;
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  if (!fs.existsSync(rceditPath) || fs.statSync(rceditPath).size < 100000) {
    console.log('[after-pack-icon] downloading rcedit…');
    await download(RCEDIT_URL, rceditPath);
  }

  console.log('[after-pack-icon] embedding icon into', exePath);
  const args = [exePath, '--set-icon', icoPath];
  let lastErr = null;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      if (process.platform === 'win32') {
        execFileSync(rceditPath, args, { stdio: 'inherit' });
      } else {
        execFileSync('wine', [rceditPath, ...args], {
          stdio: 'inherit',
          env: { ...process.env, WINEDEBUG: '-all' },
        });
      }
      console.log('[after-pack-icon] done');
      return;
    } catch (err) {
      lastErr = err;
      const msg = err && err.message ? err.message : String(err);
      console.warn(`[after-pack-icon] attempt ${attempt} failed: ${msg}`);
      if (process.platform !== 'win32') break;
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  const msg = lastErr && lastErr.message ? lastErr.message : String(lastErr);
  if (process.platform === 'win32') {
    throw new Error(`[after-pack-icon] failed to embed icon: ${msg}`);
  }
  console.warn('[after-pack-icon] skipped:', msg);
};
