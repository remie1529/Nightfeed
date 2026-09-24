/**
 * Embed Nightfeed icon.ico into the Windows .exe via rcedit+wine.
 * Needed because signAndEditExecutable is false for Linux cross-builds,
 * which otherwise leaves the default Electron atom icon on desktop/taskbar.
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
  try {
    if (process.platform === 'win32') {
      execFileSync(rceditPath, [exePath, '--set-icon', icoPath], { stdio: 'inherit' });
    } else {
      execFileSync('wine', [rceditPath, exePath, '--set-icon', icoPath], {
        stdio: 'inherit',
        env: { ...process.env, WINEDEBUG: '-all' },
      });
    }
    console.log('[after-pack-icon] done');
  } catch (err) {
    console.warn('[after-pack-icon] skipped:', err && err.message ? err.message : err);
  }
};
