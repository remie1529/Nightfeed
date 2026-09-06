import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const src = path.join(root, 'build/icon.png');
const outIco = path.join(root, 'build/icon.ico');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const tmpDir = path.join(root, 'build/.icon-tmp');
fs.mkdirSync(tmpDir, { recursive: true });

const meta = await sharp(src).metadata();
console.log('source', meta.width, meta.height, meta.format);

const pngPaths = [];
for (const size of sizes) {
  const p = path.join(tmpDir, `icon-${size}.png`);
  await sharp(src)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(p);
  pngPaths.push(p);
}

const buf = await pngToIco(pngPaths);
fs.writeFileSync(outIco, buf);
console.log('wrote', outIco, buf.length, 'bytes');
fs.rmSync(tmpDir, { recursive: true, force: true });
