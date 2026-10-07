const fs = require('fs');
const path = require('path');

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"]/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]
  ));
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function stat(label, value) {
  return '<div class="stat"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>';
}

function hours(minutes) {
  const total = Math.round(num(minutes));
  if (!total) return '0 min';
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return m + ' min';
  if (!m) return h + ' h';
  return h + ' h ' + m + ' min';
}

function monitored(item) {
  return item.monitored !== false;
}

function showStats(shows) {
  const episodes = shows.reduce((sum, show) => sum + num(show.episodeCount), 0);
  const downloaded = shows.reduce((sum, show) => sum + num(show.downloadedCount), 0);
  const missing = shows.reduce((sum, show) => sum + num(show.missingCount), 0);
  const withMissing = shows.filter((show) => num(show.missingCount) > 0).length;
  const complete = shows.filter((show) => num(show.episodeCount) > 0 && num(show.missingCount) === 0).length;
  const watching = shows.filter(monitored).length;
  const paused = shows.length - watching;
  const pct = episodes ? Math.round((downloaded / episodes) * 100) : 0;
  const byStatus = {};
  for (const show of shows) {
    const key = show.status || 'Unknown';
    byStatus[key] = (byStatus[key] || 0) + 1;
  }
  const missingList = shows
    .filter((show) => num(show.missingCount) > 0)
    .sort((a, b) => num(b.missingCount) - num(a.missingCount))
    .slice(0, 8);
  const statusRows = Object.keys(byStatus)
    .sort((a, b) => byStatus[b] - byStatus[a])
    .map((key) => '<li><span>' + esc(key) + '</span><b>' + byStatus[key] + '</b></li>')
    .join('');
  const missingRows = missingList
    .map((show) => '<li><span>' + esc(show.name) + '</span><b>' + num(show.missingCount) + '</b></li>')
    .join('');
  return (
    '<section class="panel"><h2>TV shows</h2>' +
    '<div class="bar" title="' + pct + '% downloaded"><i style="width:' + pct + '%"></i></div>' +
    '<div class="stats">' +
    stat('Monitored', watching) +
    stat('Paused', paused) +
    stat('Complete', complete) +
    stat('With missing', withMissing) +
    stat('Episodes', episodes) +
    stat('Downloaded', downloaded) +
    stat('Missing', missing) +
    stat('Progress', pct + '%') +
    '</div>' +
    (statusRows ? '<h2 style="margin-top:1rem">Show status</h2><ul class="list">' + statusRows + '</ul>' : '') +
    (missingRows ? '<h2 style="margin-top:1rem">Most missing episodes</h2><ul class="list">' + missingRows + '</ul>' : '') +
    '</section>'
  );
}

function movieStats(movies) {
  const downloaded = movies.filter((movie) => movie.status === 'downloaded').length;
  const downloading = movies.filter((movie) => movie.status === 'downloading').length;
  const missing = movies.filter((movie) => !movie.status || movie.status === 'missing').length;
  const watching = movies.filter(monitored).length;
  const paused = movies.length - watching;
  const onDisk = movies.filter((movie) => movie.localPath).length;
  const runtime = movies.reduce((sum, movie) => sum + num(movie.runtime), 0);
  const years = movies.map((movie) => num(movie.releaseYear)).filter((year) => year > 0).sort((a, b) => a - b);
  const span = years.length ? (years[0] === years[years.length - 1] ? String(years[0]) : years[0] + '–' + years[years.length - 1]) : '—';
  const pct = movies.length ? Math.round((downloaded / movies.length) * 100) : 0;
  return (
    '<section class="panel"><h2>Movies</h2>' +
    '<div class="bar" title="' + pct + '% downloaded"><i style="width:' + pct + '%"></i></div>' +
    '<div class="stats">' +
    stat('Downloaded', downloaded) +
    stat('Missing', missing) +
    stat('Downloading', downloading) +
    stat('On disk', onDisk) +
    stat('Monitored', watching) +
    stat('Paused', paused) +
    stat('Runtime', hours(runtime)) +
    stat('Years', span) +
    '</div></section>'
  );
}

async function render(api) {
  const shows = await api.library.listShows();
  const movies = await api.library.listMovies();
  const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
  const html =
    '<style>' + css + '</style>' +
    '<h1>Library</h1>' +
    '<p class="intro">Counts from your library. This page updates when a show or movie is added or removed.</p>' +
    '<div class="hero">' +
    '<div class="hero-card"><span>TV shows</span><strong>' + shows.length + '</strong></div>' +
    '<div class="hero-card"><span>Movies</span><strong>' + movies.length + '</strong></div>' +
    '</div>' +
    showStats(shows) +
    movieStats(movies);
  api.ui.setPage('count', html);
}

module.exports = {
  activate(api) {
    api.ui.addPage({ id: 'count', title: 'Library count', html: '<p>Loading…</p>' });
    api.events.onLibraryChanged(() => {
      render(api).catch((err) => api.log.warn(String(err && err.message ? err.message : err)));
    });
    render(api).catch((err) => api.log.warn(String(err && err.message ? err.message : err)));
  },
};
