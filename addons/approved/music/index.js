const music = require('./music');

let apiRef = null;
let busy = '';
let selectedId = '';
let queue = Promise.resolve();
let viewSeq = 0;

function publish(extra) {
  const payload = Object.assign({
    busy,
    selectedId,
    error: '',
    notice: '',
  }, extra || {});
  const fs = require('fs');
  const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, 'page.js'), 'utf8');
  const data = JSON.stringify(payload).replace(/</g, '\\u003c');
  apiRef.ui.setPage(
    'music',
    '<style>' + css + '</style><div id="app"></div>' +
      '<script>window.__MUSIC__ = ' + data + ';</script>' +
      '<script>' + script.replace(/<\/script/gi, '<\\/script') + '</script>'
  );
}

async function folder() {
  if (!apiRef.settings || typeof apiRef.settings.get !== 'function') return '';
  return String(await apiRef.settings.get('musicRoot') || '').trim();
}

async function view(extra) {
  const seq = ++viewSeq;
  const root = await folder();
  if (seq !== viewSeq) return;
  const songs = music.loadSongs(root);
  const selected = songs.find((song) => song.id === selectedId) || null;
  if (seq !== viewSeq) return;
  publish(Object.assign({
    folder: root,
    songs,
    selected,
  }, extra || {}));
}

function failureMessage(err) {
  const text = err && err.message ? err.message : String(err);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const useful = lines.find((line) => /error|yt-dlp|ffmpeg|spotify|folder|network/i.test(line)) || lines[lines.length - 1] || text;
  return useful.replace(/^ERROR:\s*/i, '').slice(0, 300);
}

async function reportFailure(err) {
  busy = '';
  const message = failureMessage(err);
  if (apiRef && apiRef.log) apiRef.log.warn(message);
  if (apiRef && apiRef.app && typeof apiRef.app.notify === 'function') apiRef.app.notify(message);
  await view({ error: message });
  return message;
}

async function ffmpegPath() {
  if (!apiRef || !apiRef.app || typeof apiRef.app.ffmpegPath !== 'function') return '';
  try {
    return String(await apiRef.app.ffmpegPath() || '');
  } catch {
    return '';
  }
}

function enqueue(work) {
  queue = queue.then(work, work);
  return queue;
}

async function downloadInput(input, note) {
  const root = await folder();
  if (!root) throw new Error('Set the music folder in Settings first');
  const ref = music.spotifyRef(input);
  const tracks = ref
    ? await music.fetchSpotify(input)
    : [{ id: '', title: String(input || '').trim(), artist: '', album: '', year: 0, durationMs: 0, coverUrl: '', filePath: '' }];
  if (!tracks[0] || !tracks[0].title) throw new Error('Nothing to download');
  busy = 'Preparing the downloader…';
  await view({ notice: note || '' });
  const ffmpeg = await music.ensureFfmpeg(await ffmpegPath());
  await music.ensureYtDlp();
  let done = 0;
  for (const track of tracks) {
    done += 1;
    await music.downloadTrack(track, root, ffmpeg, async (attempt) => {
      busy = (attempt > 1 ? 'Trying again (' + attempt + '/3): ' : 'Downloading ' + done + '/' + tracks.length + ': ') + track.title;
      await view({ notice: note || '' });
    });
  }
  busy = '';
  await view({ notice: 'Saved ' + tracks.length + ' song' + (tracks.length === 1 ? '' : 's') + '.' });
}

async function perform(action, payload) {
  const body = payload || {};
  if (action === 'open') {
    selectedId = String(body.id || '');
    await view();
    return { ok: true };
  }
  if (action === 'back') {
    selectedId = '';
    await view();
    return { ok: true };
  }
  if (action === 'reveal' || action === 'play') {
    try {
      const filePath = String(body.path || '');
      if (action === 'play') music.playFile(filePath);
      else music.openFile(filePath);
      return { ok: true };
    } catch (err) {
      const message = failureMessage(err);
      await view({ error: message });
      return { ok: false, error: message };
    }
  }
  if (action === 'download') {
    const query = String(body.query || '').trim();
    if (!query) return { ok: false, error: 'Paste a song name or Spotify link' };
    enqueue(() => downloadInput(query).catch((err) => reportFailure(err)));
    if (!busy) {
      busy = 'Starting…';
      await view();
    }
    return { ok: true };
  }
  await view();
  return { ok: false, error: 'Unknown action' };
}

module.exports = {
  activate(api) {
    apiRef = api;
    if (api.settings && typeof api.settings.define === 'function') {
      api.settings.define([
        {
          id: 'musicRoot',
          label: 'Music folder',
          type: 'folder',
          description: 'Downloaded songs are saved in this folder.',
        },
      ]);
      if (typeof api.settings.onChanged === 'function') {
        api.settings.onChanged(() => {
          view().catch(() => undefined);
        });
      }
    }
    api.ui.addPage({ id: 'music', title: 'Music', html: '<p>Loading…</p>' });
    api.ui.onAction((action, payload) => perform(String(action || ''), payload));
    if (api.telegram && typeof api.telegram.command === 'function') {
      api.telegram.command('music', {
        audience: 'admin',
        description: 'Music folder, or playlist <Spotify link> to download now',
        async run(args) {
          const text = String(args || '').trim();
          if (/^playlist\s+/i.test(text)) {
            const link = text.replace(/^playlist\s+/i, '').trim();
            const root = await folder();
            if (!root) return 'Set the music folder in Nightfeed Settings first.';
            if (!music.spotifyRef(link)) return 'Usage: /music playlist <Spotify playlist or track link>';
            enqueue(() => downloadInput(link, 'Started from Telegram').catch((err) => reportFailure(err)));
            return 'Downloading that Spotify link into the music folder.';
          }
          const root = await folder();
          const count = music.loadSongs(root).length;
          return root
            ? 'Music folder: ' + root + '\n' + count + ' saved song' + (count === 1 ? '' : 's') + '.\n/music playlist <Spotify link>'
            : 'Set the music folder in Nightfeed Settings first.';
        },
      });
      api.telegram.command('request-music', {
        audience: 'all',
        description: 'Request a song or Spotify link. An admin approves it.',
        async run(args, meta) {
          const title = String(args || '').trim();
          if (!title) return 'Usage: /request-music artist - song\nor /request-music <Spotify link>';
          if (!api.requests || typeof api.requests.submit !== 'function') {
            return 'Update Nightfeed to send music requests.';
          }
          const result = await api.requests.submit({
            title,
            overview: music.spotifyRef(title) ? title : '',
            requesterChatId: meta && meta.chatId,
            requesterName: meta && meta.fromName,
          });
          return (result && result.message) || 'Request sent.';
        },
      });
    }
    if (api.requests && typeof api.requests.onResolved === 'function') {
      api.requests.onResolved((request, action) => {
        if (action !== 'approved' || !request) return undefined;
        const title = String(request.title || request.overview || '').trim();
        return enqueue(() => downloadInput(title).then(async () => {
          if (request.id && api.requests.complete) await api.requests.complete(request.id);
        }).catch(async (err) => {
          const message = await reportFailure(err);
          if (request.id && api.requests.fail) await api.requests.fail(request.id, message);
        }));
      });
    }
    view().catch((err) => api.log.warn(err && err.message ? err.message : String(err)));
  },
};
