const { execFile, spawn } = require('child_process');
const fs = require('fs');
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

async function downloadTrack(track, folder, ffmpegPath) {
  if (!folder) throw new Error('Set the music folder in Settings first');
  fs.mkdirSync(folder, { recursive: true });
  const bin = await ensureYtDlp();
  const ffmpeg = (ffmpegPath && fs.existsSync(ffmpegPath) ? ffmpegPath : '') || localFfmpeg();
  if (!ffmpeg) {
    throw new Error('Nightfeed could not download ffmpeg. Check the network, then try again.');
  }
  const query = [track.artist, track.title].filter(Boolean).join(' - ').slice(0, 180);
  const args = [
    '-x',
    '--audio-format',
    'mp3',
    '--no-playlist',
    '--print',
    'after_move:filepath',
    '-o',
    path.join(folder, '%(title)s.%(ext)s'),
  ];
  if (ffmpeg) args.push('--ffmpeg-location', ffmpeg);
  args.push('ytsearch1:' + query);
  let stdout = '';
  try {
    const result = await execFileAsync(bin, args, {
      windowsHide: true,
      timeout: 300000,
      maxBuffer: 2 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (/ffmpeg/i.test(message)) {
      throw new Error('Nightfeed could not prepare ffmpeg for this song. Check the network, then try again.');
    }
    throw err instanceof Error ? err : new Error(message);
  }
  const filePath = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('The song did not save. Check that yt-dlp can reach the network.');
  }
  try {
    await tagFile(ffmpeg, filePath, track);
  } catch {
    // The audio file is already saved. Tags are optional.
  }
  const song = {
    ...track,
    id: track.id || query.toLowerCase(),
    filePath,
    downloadedAt: new Date().toISOString(),
  };
  rememberSong(folder, song);
  return song;
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
  downloadTrack,
  loadSongs,
  openFile,
  playFile,
};
