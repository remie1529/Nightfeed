(function () {
  const root = document.getElementById('app');
  const state = window.__MUSIC__ || { songs: [], selected: null, folder: '', busy: '', error: '', notice: '' };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function mins(ms) {
    const n = Number(ms) || 0;
    if (!n) return '';
    const total = Math.round(n / 1000);
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }

  const NO_IMAGE = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">' +
    '<rect width="400" height="400" fill="#1a1a1a"/>' +
    '<text x="200" y="188" text-anchor="middle" fill="#9a9690" font-family="Segoe UI,sans-serif" font-size="22">No Image</text>' +
    '<text x="200" y="218" text-anchor="middle" fill="#6a6660" font-family="Segoe UI,sans-serif" font-size="18">found</text>' +
    '</svg>'
  );

  function coverArt(song, className) {
    const img = document.createElement('img');
    img.className = className || '';
    img.alt = '';
    img.src = song.coverUrl || NO_IMAGE;
    img.onerror = () => {
      img.onerror = null;
      img.src = NO_IMAGE;
    };
    return img;
  }

  root.textContent = '';
  if (state.selected) {
    const song = state.selected;
    const bar = el('div', 'toolbar');
    const back = el('button', '', '← Music');
    back.type = 'button';
    back.onclick = () => window.nightfeed.call('back', {});
    bar.appendChild(back);
    root.appendChild(bar);
    const detail = el('section', 'detail');
    const cover = coverArt(song, 'cover');
    const copy = el('div');
    copy.appendChild(el('h1', '', song.title || 'Untitled'));
    copy.appendChild(el('p', 'sub', [song.artist, song.album, song.year || ''].filter(Boolean).join(' · ')));
    const meta = el('div', 'meta-grid');
    [
      ['Artist', song.artist || '—'],
      ['Album', song.album || '—'],
      ['Year', song.year || '—'],
      ['Length', mins(song.durationMs) || '—'],
    ].forEach(([label, value]) => {
      const field = el('div');
      field.appendChild(el('span', '', label));
      field.appendChild(el('strong', '', String(value)));
      meta.appendChild(field);
    });
    copy.appendChild(meta);
    if (song.filePath) copy.appendChild(el('p', 'path', song.filePath));
    const actions = el('div', 'actions');
    const play = el('button', 'primary', 'Play');
    play.type = 'button';
    play.onclick = () => window.nightfeed.call('play', { path: song.filePath });
    const reveal = el('button', '', 'Show file');
    reveal.type = 'button';
    reveal.onclick = () => window.nightfeed.call('reveal', { path: song.filePath });
    actions.appendChild(play);
    actions.appendChild(reveal);
    copy.appendChild(actions);
    detail.appendChild(cover);
    detail.appendChild(copy);
    root.appendChild(detail);
    return;
  }

  const header = el('div');
  header.appendChild(el('h1', '', 'Music'));
  header.appendChild(el('p', 'intro', state.folder
    ? 'Songs saved in ' + state.folder + '. A Spotify link fills in the song list. yt-dlp saves the audio as MP3. A playlist keeps the tracks on that page, up to 100.'
    : 'Set the music folder under Settings, in the Music section. Downloads use yt-dlp.'));
  root.appendChild(header);
  if (state.error) root.appendChild(el('div', 'banner', state.error));
  if (state.notice) root.appendChild(el('div', 'note', state.notice));
  if (state.busy) root.appendChild(el('div', 'note', state.busy));

  const form = el('div', 'download-row');
  const input = document.createElement('input');
  input.placeholder = 'Spotify playlist or track link, or artist - song';
  input.disabled = !!state.busy;
  const go = el('button', 'primary', 'Download');
  go.type = 'button';
  go.disabled = !!state.busy;
  go.onclick = async () => {
    go.disabled = true;
    await window.nightfeed.call('download', { query: input.value });
  };
  form.appendChild(input);
  form.appendChild(go);
  root.appendChild(form);

  const songs = state.songs || [];
  if (!songs.length) {
    root.appendChild(el('p', 'empty', 'No songs saved yet. Telegram users can /request-music a song. Admins approve it in Requests.'));
    return;
  }
  const grid = el('div', 'grid');
  songs.forEach((song) => {
    const card = el('button', 'card');
    card.type = 'button';
    card.appendChild(coverArt(song));
    card.appendChild(el('strong', '', song.title || 'Untitled'));
    card.appendChild(el('span', '', song.artist || 'Unknown artist'));
    card.onclick = () => window.nightfeed.call('open', { id: song.id });
    grid.appendChild(card);
  });
  root.appendChild(grid);
})();
