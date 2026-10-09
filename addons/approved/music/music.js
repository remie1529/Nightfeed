const { execFile, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const LIBRARY = 'nightfeed-music.json';

function spotifyRef(input) {
  const text = String(input || '').trim();
  const playlist = text.match(/playlist\/([A-Za-z0-9]+)/);
  if (playlist) return { kind: 'playlist', id: playlist[1] };
  const track = text.match(/track\/([A-Za-z0-9]+)/);
  if (track) return { kind: 'track', id: track[1] };
  return null;
}

function libraryPath(folder) {
  return path.join(folder, LIBRARY);
}

function loadSongs(folder) {
  if (!folder) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(libraryPath(folder), 'utf8'));
    return Array.isArray(raw.songs) ? raw.songs : [];
  } catch {
    return [];
  }
}

function saveSongs(folder, songs) {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(libraryPath(folder), JSON.stringify({ songs }, null, 2), 'utf8');
}

function rememberSong(folder, song) {
  const songs = loadSongs(folder).filter((item) => item.id !== song.id);
  songs.unshift(song);
  saveSongs(folder, songs);
  return songs;
}

function coverFrom(entity) {
  const image = entity && entity.visualIdentity && entity.visualIdentity.image;
  if (image && image[0] && image[0].url) return String(image[0].url);
  const sources = entity && entity.coverArt && entity.coverArt.sources;
  if (!sources || !sources.length) return '';
  const last = sources[sources.length - 1];
  return String((last && last.url) || sources[0].url || '');
}

function artistFrom(item) {
  if (item && item.subtitle) return String(item.subtitle).trim();
  return ((item && item.artists) || []).map((artist) => artist && artist.name).filter(Boolean).join(', ');
}

function mapEmbedTrack(item, album, fallbackCover) {
  const uri = String((item && item.uri) || '');
  return {
    id: uri.replace('spotify:track:', '') || String((item && (item.id || item.title)) || ''),
    title: String((item && item.title) || '').trim(),
    artist: artistFrom(item),
    album: album || '',
    year: Number(String((item && item.releaseDate && item.releaseDate.isoString) || '').slice(0, 4)) || 0,
    durationMs: Number(item && item.duration) || 0,
    coverUrl: coverFrom(item) || fallbackCover || '',
    filePath: '',
  };
}

async function fetchEmbed(kind, id) {
  const res = await fetch('https://open.spotify.com/embed/' + kind + '/' + id, {
    headers: {
      accept: 'text/html',
      'user-agent': 'Mozilla/5.0',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('Spotify did not answer (' + res.status + ')');
  const html = await res.text();
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Spotify did not return track data');
  const data = JSON.parse(match[1]);
  const entity = data.props && data.props.pageProps && data.props.pageProps.state
    && data.props.pageProps.state.data && data.props.pageProps.state.data.entity;
  if (!entity) throw new Error('Spotify did not return track data');
  return entity;
}

async function fetchSpotify(input) {
  const ref = spotifyRef(input);
  if (!ref) throw new Error('Paste a Spotify track or playlist link');
  const entity = await fetchEmbed(ref.kind, ref.id);
  if (ref.kind === 'track') {
    const track = mapEmbedTrack(entity, entity.subtitle || '', coverFrom(entity));
    if (!track.title) throw new Error('That Spotify track could not be read');
    return [track];
  }
  const cover = coverFrom(entity);
  const tracks = (entity.trackList || [])
    .map((item) => mapEmbedTrack(item, entity.name || '', cover))
    .filter((track) => track.title);
  if (!tracks.length) throw new Error('That playlist has no tracks');
  return tracks.slice(0, 100);
}

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
let ytdlpInstall = null;

function toolDir() {
  const base = process.env.APPDATA || process.env.TEMP || process.cwd();
  return path.join(base, 'Nightfeed', 'yt-dlp');
}

async function exeWorks(file) {
  try {
    await execFileAsync(file, ['--version'], { windowsHide: true, timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

async function installYtDlp(dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  let res;
  try {
    res = await fetch(YTDLP_URL, {
      headers: { 'user-agent': 'Nightfeed' },
      redirect: 'follow',
      signal: AbortSignal.timeout(180000),
    });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    throw new Error('Nightfeed could not download yt-dlp. Check the network, then try again. ' + message);
  }
  if (!res.ok) {
    throw new Error('Nightfeed could not download yt-dlp (HTTP ' + res.status + '). Check the network, then try again.');
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000000) {
    throw new Error('Nightfeed could not download yt-dlp. Check the network, then try again.');
  }
  fs.writeFileSync(part, buf);
  if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
  fs.renameSync(part, dest);
  if (!(await exeWorks(dest))) {
    fs.rmSync(dest, { force: true });
    throw new Error('Nightfeed downloaded yt-dlp, but it did not start.');
  }
  return dest;
}

async function ensureYtDlp() {
  const dest = path.join(toolDir(), 'yt-dlp.exe');
  if (await exeWorks(dest)) return dest;
  for (const name of ['yt-dlp.exe', 'yt-dlp']) {
    if (await exeWorks(name)) return name;
  }
  if (!ytdlpInstall) {
    ytdlpInstall = installYtDlp(dest).finally(() => {
      ytdlpInstall = null;
    });
  }
  return ytdlpInstall;
}

function localFfmpeg() {
  const candidates = [];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'Nightfeed', 'ffmpeg', 'ffmpeg.exe'));
  }
  candidates.push('C:\\ffmpeg\\bin\\ffmpeg.exe');
  candidates.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe'));
  return candidates.find((file) => file && fs.existsSync(file)) || '';
}

const FFMPEG_ZIP = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
let ffmpegInstall = null;

function appDataDir(name) {
  const base = process.env.APPDATA || process.env.TEMP || process.cwd();
  return path.join(base, 'Nightfeed', name);
}

function findFile(dir, name) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return '';
}

function downloadToFile(url, dest, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 8) {
      reject(new Error('Too many redirects'));
      return;
    }
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'user-agent': 'Nightfeed' } }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        downloadToFile(new URL(res.headers.location, url).toString(), dest, hops + 1).then(resolve, reject);
        return;
      }
      if (code !== 200) {
        res.resume();
        reject(new Error('Download failed (HTTP ' + code + ')'));
        return;
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
    });
    req.setTimeout(300000, () => req.destroy(new Error('Download timed out')));
    req.on('error', reject);
  });
}

async function installFfmpeg(dest) {
  const dir = path.dirname(dest);
  const zip = path.join(dir, 'ffmpeg-essentials.zip');
  const extract = path.join(dir, 'extract');
  fs.mkdirSync(dir, { recursive: true });
  await downloadToFile(FFMPEG_ZIP, zip);
  await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      "Expand-Archive -LiteralPath '" + zip.replace(/'/g, "''") + "' -DestinationPath '" + extract.replace(/'/g, "''") + "' -Force",
    ],
    { windowsHide: true, timeout: 180000 }
  );
  const exe = findFile(extract, 'ffmpeg.exe');
  if (!exe) throw new Error('Nightfeed could not download ffmpeg. Check the network, then try again.');
  fs.copyFileSync(exe, dest);
  const probe = findFile(extract, 'ffprobe.exe');
  if (probe) fs.copyFileSync(probe, path.join(dir, 'ffprobe.exe'));
  if (!fs.existsSync(dest)) throw new Error('Nightfeed could not download ffmpeg. Check the network, then try again.');
  return dest;
}

async function ensureFfmpeg(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const dest = path.join(appDataDir('ffmpeg'), 'ffmpeg.exe');
  if (fs.existsSync(dest)) return dest;
  const local = localFfmpeg();
  if (local) return local;
  if (!ffmpegInstall) {
    ffmpegInstall = installFfmpeg(dest).finally(() => {
      ffmpegInstall = null;
    });
  }
  return ffmpegInstall;
}

function safeName(track) {
  const raw = [track.artist, track.title].filter(Boolean).join(' - ') || track.title || 'song';
  return raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'song';
}

function targetFile(folder, track) {
  const base = safeName(track);
  const plain = path.join(folder, base + '.mp3');
  if (!fs.existsSync(plain)) return plain;
  const extra = String(track.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 12);
  return path.join(folder, base + (extra ? ' (' + extra + ')' : ' (2)') + '.mp3');
}

function runTool(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error('The download took too long')));
    }, timeoutMs);
    child.stdout.on('data', (buf) => {
      stdout = (stdout + buf.toString()).slice(-8000);
    });
    child.stderr.on('data', (buf) => {
      stderr = (stderr + buf.toString()).slice(-4000);
    });
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) => finish(() => resolve({ code: code || 0, stdout, stderr })));
  });
}

function shortReason(stderr) {
  const lines = String(stderr || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const error = [...lines].reverse().find((line) => /^ERROR:/i.test(line)) || lines[lines.length - 1] || '';
  return error.replace(/^ERROR:\s*/i, '').slice(0, 240);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canRetry(err) {
  const message = err && err.message ? err.message : String(err);
  if (/music folder/i.test(message)) return false;
  if (/did not start/i.test(message)) return false;
  return true;
}

function tagValue(value) {
  return String(value || '').replace(/[\r\n]/g, ' ').slice(0, 180);
}

async function tagFile(ffmpeg, filePath, track) {
  if (!ffmpeg || !filePath || !fs.existsSync(filePath) || !/\.mp3$/i.test(filePath)) return;
  const tmp = filePath.replace(/\.mp3$/i, '') + '.tag.mp3';
  const args = ['-y', '-i', filePath, '-c', 'copy'];
  if (track.title) args.push('-metadata', 'title=' + tagValue(track.title));
  if (track.artist) args.push('-metadata', 'artist=' + tagValue(track.artist));
  if (track.album) args.push('-metadata', 'album=' + tagValue(track.album));
  if (track.year) args.push('-metadata', 'date=' + String(track.year));
  args.push(tmp);
  await execFileAsync(ffmpeg, args, { windowsHide: true, timeout: 60000 });
  const backup = filePath + '.bak';
  fs.renameSync(filePath, backup);
  try {
    fs.renameSync(tmp, filePath);
    fs.rmSync(backup, { force: true });
  } catch (err) {
    if (!fs.existsSync(filePath) && fs.existsSync(backup)) fs.renameSync(backup, filePath);
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    throw err;
  }
}

async function convertToMp3(ffmpeg, source, dest) {
  if (path.resolve(source) === path.resolve(dest)) return dest;
  if (source.toLowerCase().endsWith('.mp3')) {
    fs.renameSync(source, dest);
    return dest;
  }
  await execFileAsync(ffmpeg, ['-y', '-i', source, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', dest], {
    windowsHide: true,
    timeout: 180000,
  });
  fs.rmSync(source, { force: true });
  return dest;
}

async function downloadOnce(track, folder, bin, ffmpeg) {
  const query = [track.artist, track.title].filter(Boolean).join(' - ').slice(0, 180);
  const token = 'nf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const produced = () => fs.readdirSync(folder)
    .filter((name) => name.startsWith(token + '.'))
    .map((name) => path.join(folder, name))
    .filter((file) => fs.existsSync(file) && fs.statSync(file).size > 10000);
  let result;
  try {
    result = await runTool(bin, [
      '-x',
      '--audio-format',
      'mp3',
      '--ffmpeg-location',
      ffmpeg,
      '--no-playlist',
      '--no-mtime',
      '-o',
      path.join(folder, token + '.%(ext)s'),
      'ytsearch1:' + query,
    ], 300000);
  } catch (err) {
    for (const file of produced()) fs.rmSync(file, { force: true });
    throw err;
  }
  const files = produced();
  const mp3 = files.find((file) => file.toLowerCase().endsWith('.mp3'));
  const source = mp3 || files.find((file) => /\.(m4a|webm|opus|ogg|flac|wav)$/i.test(file));
  if (!source) {
    for (const file of files) fs.rmSync(file, { force: true });
    const reason = shortReason(result.stderr);
    throw new Error(reason || 'The song did not save. Trying again when the network allows it.');
  }
  const dest = targetFile(folder, track);
  try {
    await convertToMp3(ffmpeg, source, dest);
  } catch (err) {
    for (const file of produced()) fs.rmSync(file, { force: true });
    throw err;
  }
  for (const file of produced()) {
    if (path.resolve(file) !== path.resolve(dest)) fs.rmSync(file, { force: true });
  }
  if (!fs.existsSync(dest) || fs.statSync(dest).size < 10000) {
    fs.rmSync(dest, { force: true });
    throw new Error('The song did not save. Trying again when the network allows it.');
  }
  try {
    await tagFile(ffmpeg, dest, track);
  } catch {
    // The audio file is already saved. Tags are optional.
  }
  const song = {
    ...track,
    id: track.id || query.toLowerCase(),
    filePath: dest,
    downloadedAt: new Date().toISOString(),
  };
  rememberSong(folder, song);
  return song;
}

async function downloadTrack(track, folder, ffmpegPath, onAttempt) {
  if (!folder) throw new Error('Set the music folder in Settings first');
  fs.mkdirSync(folder, { recursive: true });
  const bin = await ensureYtDlp();
  const ffmpeg = await ensureFfmpeg(ffmpegPath);
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (typeof onAttempt === 'function') {
      await onAttempt(attempt);
    }
    try {
      return await downloadOnce(track, folder, bin, ffmpeg);
    } catch (err) {
      last = err;
      if (attempt === 3 || !canRetry(err)) break;
      await delay(2000 * attempt);
    }
  }
  throw last instanceof Error ? last : new Error(String(last || 'The song did not save'));
}

function assertFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error('That file is not on disk');
}

function openFile(filePath) {
  assertFile(filePath);
  const child = spawn('explorer.exe', ['/select,' + filePath], { windowsHide: true, stdio: 'ignore', detached: true });
  child.unref();
}

function playFile(filePath) {
  assertFile(filePath);
  const child = spawn('explorer.exe', [filePath], { windowsHide: true, stdio: 'ignore', detached: true });
  child.unref();
}

module.exports = {
  spotifyRef,
  fetchSpotify,
  ensureYtDlp,
  ensureFfmpeg,
  downloadTrack,
  loadSongs,
  openFile,
  playFile,
};
