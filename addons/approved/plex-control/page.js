(function () {
  const root = document.getElementById('app');
  const state = window.__PLEX__ || { status: null, error: '', busy: false };
  const status = state.status || {};

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(label, action, className) {
    const node = el('button', className || '', label);
    node.type = 'button';
    node.disabled = !!state.busy;
    node.onclick = async () => {
      node.disabled = true;
      await window.nightfeed.call(action, {});
    };
    return node;
  }

  root.textContent = '';
  const header = el('div');
  header.appendChild(el('h1', '', 'Plex'));
  header.appendChild(el('p', 'intro', 'Control Plex Media Server on this PC. Telegram admins can use /plex.'));
  root.appendChild(header);

  if (state.error) root.appendChild(el('div', 'banner', state.error));
  if (status.note && status.note !== state.error) root.appendChild(el('div', status.running ? 'note' : 'banner', status.note));

  const hero = el('section', 'hero ' + (status.running ? 'on' : 'off'));
  hero.appendChild(el('span', 'eyebrow', status.friendlyName || 'Plex Media Server'));
  hero.appendChild(el('strong', '', state.busy ? 'Working…' : (status.running ? 'Running' : 'Stopped')));
  const sub = [status.version ? 'Version ' + status.version : '', status.path || 'Executable not found'].filter(Boolean).join(' · ');
  hero.appendChild(el('p', '', sub));
  root.appendChild(hero);

  const stats = el('div', 'stats');
  [
    ['PID', status.pid || '—'],
    ['Memory', status.memoryMb ? status.memoryMb + ' MB' : '—'],
    ['Uptime', status.uptime || '—'],
    ['Processes', status.count || (status.running ? 1 : 0)],
  ].forEach(([label, value]) => {
    const card = el('div', 'stat');
    card.appendChild(el('span', '', label));
    card.appendChild(el('strong', '', String(value)));
    stats.appendChild(card);
  });
  root.appendChild(stats);

  const tools = el('div', 'toolbar');
  tools.appendChild(button('Refresh', 'refresh', ''));
  tools.appendChild(button('Start', 'start', 'primary'));
  tools.appendChild(button('Stop', 'stop', ''));
  tools.appendChild(button('Kill', 'kill', 'danger'));
  tools.appendChild(button('Restart', 'restart', ''));
  tools.appendChild(button('Open web', 'web', ''));
  root.appendChild(tools);

  const watching = el('section', 'panel');
  watching.appendChild(el('h2', '', 'Watching'));
  const sessions = status.sessions || [];
  if (!status.running) {
    watching.appendChild(el('p', 'empty', 'Plex is stopped.'));
  } else if (!sessions.length) {
    watching.appendChild(el('p', 'empty', status.sessionsNote || 'Nobody is watching.'));
  } else {
    const list = el('ul', 'sessions');
    sessions.forEach((item) => {
      const row = el('li');
      row.appendChild(el('strong', '', item.title));
      const meta = [item.user, item.player, item.progress].filter(Boolean).join(' · ');
      if (meta) row.appendChild(el('span', '', meta));
      list.appendChild(row);
    });
    watching.appendChild(list);
  }
  root.appendChild(watching);

  root.appendChild(el('p', 'hint', 'Telegram: /plex status, start, stop, kill, restart, web'));
})();
