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

  const tokenPanel = el('section', 'panel token-panel');
  tokenPanel.appendChild(el('h2', '', 'Plex token'));
  if (status.tokenSource === 'saved') {
    tokenPanel.appendChild(el('p', 'empty', 'Using the token saved in Nightfeed. It is not shown here.'));
  } else if (status.tokenSource === 'plex') {
    tokenPanel.appendChild(el('p', 'empty', 'Using the token Plex already stored on this PC. Paste another one only if now playing stays empty.'));
  } else {
    tokenPanel.appendChild(el('p', 'empty', 'Nightfeed looked in Plex’s Preferences.xml and did not find a token. Paste one to show who is watching.'));
  }
  const steps = el('ol', 'steps');
  [
    'On this PC, open Plex in the browser and sign in.',
    'Open any movie or episode, choose the … menu, then Get Info, then View XML.',
    'In the address bar, copy the text after X-Plex-Token=.',
    'Paste it below and choose Save token. You can paste the whole address.',
  ].forEach((line) => steps.appendChild(el('li', '', line)));
  tokenPanel.appendChild(steps);
  const row = el('div', 'token-row');
  const input = document.createElement('input');
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'X-Plex-Token';
  input.disabled = !!state.busy;
  const save = el('button', 'primary', 'Save token');
  save.type = 'button';
  save.disabled = !!state.busy;
  save.onclick = async () => {
    save.disabled = true;
    await window.nightfeed.call('save-token', { token: input.value });
  };
  row.appendChild(input);
  row.appendChild(save);
  if (status.tokenSource === 'saved') {
    const clear = el('button', '', 'Remove saved token');
    clear.type = 'button';
    clear.disabled = !!state.busy;
    clear.onclick = async () => {
      clear.disabled = true;
      await window.nightfeed.call('clear-token', {});
    };
    row.appendChild(clear);
  }
  tokenPanel.appendChild(row);
  root.appendChild(tokenPanel);

  root.appendChild(el('p', 'hint', 'Telegram: /plex status, start, stop, kill, restart, web'));
})();
