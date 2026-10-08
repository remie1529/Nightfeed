const fs = require('fs');
const path = require('path');
const plex = require('./plex');

let apiRef = null;
let busy = false;

function publish(payload) {
  const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, 'page.js'), 'utf8');
  const data = JSON.stringify(payload).replace(/</g, '\\u003c');
  apiRef.ui.setPage(
    'plex',
    '<style>' + css + '</style><div id="app"></div>' +
      '<script>window.__PLEX__ = ' + data + ';</script>' +
      '<script>' + script.replace(/<\/script/gi, '<\\/script') + '</script>'
  );
}

async function render(note) {
  try {
    const status = await plex.snapshot(note || '');
    publish({ status, error: '', busy });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    apiRef.log.warn(message);
    publish({ status: null, error: message, busy: false });
  }
}

async function perform(action) {
  if (action === 'refresh') {
    await render('');
    return { ok: true };
  }
  if (!['start', 'stop', 'kill', 'restart', 'web'].includes(action)) {
    return { ok: false, error: 'Unknown action' };
  }
  if (busy) return { ok: false, error: 'Plex control is already working' };
  busy = true;
  publish({ status: null, error: '', busy: true });
  try {
    let status;
    if (action === 'start') status = await plex.startServer();
    else if (action === 'stop') status = await plex.stopServer(false);
    else if (action === 'kill') status = await plex.stopServer(true);
    else if (action === 'restart') status = await plex.restartServer();
    else {
      plex.openWeb();
      status = await plex.snapshot('Opened Plex in the browser.');
    }
    apiRef.log.info('Plex ' + action + ': ' + (status.running ? 'running' : 'stopped'));
    busy = false;
    publish({ status, error: '', busy: false });
    return { ok: true };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    apiRef.log.warn(message);
    busy = false;
    await render(message);
    return { ok: false, error: message };
  }
}

module.exports = {
  activate(api) {
    apiRef = api;
    api.ui.addPage({ id: 'plex', title: 'Plex', html: '<p>Loading…</p>' });
    api.ui.onAction((action) => perform(String(action || '')));
    if (api.telegram && typeof api.telegram.command === 'function') {
      api.telegram.command('plex', {
        description: 'Plex server: status, start, stop, kill, restart, web',
        run(args) {
          return plex.runCommand(args);
        },
      });
    }
    render('').catch((err) => api.log.warn(err && err.message ? err.message : String(err)));
  },
};
