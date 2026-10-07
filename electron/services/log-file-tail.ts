import fs from 'fs';

/** Read at most `maxBytes` from the end of a file. Does not load the rest. */
export function readTailBytes(
  file: string,
  maxBytes: number
): { text: string; size: number; truncated: boolean } {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return { text: '', size, truncated: false };
    const take = Math.min(size, Math.max(0, maxBytes));
    const buf = Buffer.alloc(take);
    fs.readSync(fd, buf, 0, take, size - take);
    let text = buf.toString('utf8');
    if (size > maxBytes) {
      const nl = text.indexOf('\n');
      if (nl >= 0 && nl < text.length - 1) text = text.slice(nl + 1);
    }
    return { text, size, truncated: size > maxBytes };
  } catch {
    return { text: '', size: 0, truncated: false };
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}
