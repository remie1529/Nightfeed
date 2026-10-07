async function render(api) {
  const shows = await api.library.listShows();
  const movies = await api.library.listMovies();
  api.ui.setPage(
    'count',
    '<h1>Library count</h1>' +
      '<p>' + shows.length + ' show' + (shows.length === 1 ? '' : 's') + '</p>' +
      '<p>' + movies.length + ' movie' + (movies.length === 1 ? '' : 's') + '</p>'
  );
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
