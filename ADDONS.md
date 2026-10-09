# Nightfeed addons

Addons are small JavaScript packages. An approved addon appears in the in-app store. Anyone can also install an addon from a file on their own PC.

Each enabled addon runs in its own background worker, one process per addon. The window process stays up if that worker crashes or spends a long time in `activate`. The addon still uses Node (`fs`, `path`, network) and the API below to read and change the library. Install only addons you trust. A local addon is not reviewed.

## Package

A folder, or a `.zip` of that folder, with `addon.json` at the top (or one folder down):

```text
my-addon/
  addon.json
  index.js
```

`addon.json`:

```json
{
  "id": "example.my-addon",
  "name": "My addon",
  "version": "1.0.0",
  "description": "What it does, in one sentence.",
  "author": "Your name",
  "api": 1,
  "main": "index.js",
  "files": ["index.js"]
}
```

Rules:

- `id` is lowercase letters, digits, dots, and dashes. It stays the same across versions.
- `api` must be `1`.
- `main` and every path in `files` stay inside the folder. `..` is rejected.
- `index.js` is CommonJS (`module.exports`).

## Entry

```js
module.exports = {
  activate(api) {
    api.log.info('started');
  },
  deactivate() {
    // Called when the addon is disabled or removed.
  },
};
```

`activate` may be async. If it throws, Nightfeed keeps running and shows the error in the addon manager. The rest of the app is not stopped.

## API

### App

- `api.app.version` is the Nightfeed version string.
- `api.app.notify(message)` shows a toast.
- `api.app.ffmpegPath()` returns the ffmpeg Nightfeed uses. On Windows it downloads one into app data when none is installed.

### Log

- `api.log.info(message)`
- `api.log.warn(message)`

Lines are written to the activity log with category `addon`. Do not log passwords, VPN profiles, or bot tokens.

### Library

- `api.library.listShows()` returns the library grid rows (name, counts, poster). It does not include every episode.
- `api.library.listMovies()` returns the movie list.
- `api.library.addShow(mazeId, policy)` adds a TVMaze show. `policy` is `'all'`, `'future'`, or `'manual'`. `'future'` keeps only episodes that have not aired.
- `api.library.addMovie(imdbNumericId)` adds a movie. The id is the number from an IMDb id (`tt1375666` is `1375666`). A movie folder must already be set in Settings.
- `api.library.removeShow(mazeId)`
- `api.library.removeMovie(imdbNumericId)`

### Downloads

- `api.downloads.list()` returns the current download items.

### Pages

- `api.ui.addPage({ id, title, html })` adds a page and a left-nav tab with that title. The id is unique inside this addon. The tab is there only while the addon is installed and turned on.
- `api.ui.setPage(id, html)` replaces that page’s HTML.
- `api.ui.onAction(function (action, payload) { ... })` handles button clicks from that page. Return a value, or a promise, and the page receives it.
- `api.ui.openShow(mazeId)` opens a show that is already in the library. Back returns to the addon tab.
- `api.ui.openMovie(imdbNumericId)` opens a movie that is already in the library. Back returns to the addon tab.

The page runs in a frame. From a script in that HTML, call:

```js
const result = await window.nightfeed.call('add', { kind: 'show', id: 123 });
```

`index.js` receives that through `onAction`. The frame cannot read Nightfeed’s own screens. Use `openShow` and `openMovie` when the title is already in the library.

### Settings

An addon can add fields to the Nightfeed Settings screen.

```js
api.settings.define([
  {
    id: 'musicRoot',
    label: 'Music folder',
    type: 'folder',
    description: 'Downloaded songs are saved here.',
  },
]);
const folder = await api.settings.get('musicRoot');
```

`type` is `folder` or `text`. Values are saved for that addon only.

### Requests

A music-style request uses the same Requests list as TV and movies.

```js
await api.requests.submit({
  title: 'Artist - Song',
  requesterChatId: meta.chatId,
  requesterName: meta.fromName,
});
api.requests.onResolved(async (request, action) => {
  if (action !== 'approved') return;
  try {
    // download request.title, then:
    await api.requests.complete(request.id);
  } catch (err) {
    await api.requests.fail(request.id, err.message);
  }
});
```

Approving it in Requests or with `/approve <id>` tells the addon. `complete` marks it downloaded and tells the requester. `fail` tells the requester it did not save. Denying it does not start a download.

### Telegram

A command is for admin chats unless `audience` says otherwise. `requests` is request chats only. `all` is both.

```js
api.telegram.command('plex', {
  description: 'Plex server status, start, stop, kill, or restart',
  async run(args) {
    return 'Plex is running';
  },
});
```

`/plex start` arrives as `args === 'start'`. The second argument is `{ chatId, fromName }`. Set `audience` to `admin` (the default), `requests`, or `all`. Built-in Nightfeed commands such as `/status` stay with Nightfeed. Do not put bot tokens or passwords in the reply.

### Events

- `api.events.onLibraryChanged(fn)` runs after the show or movie library changes. It returns an unsubscribe function.
- `api.events.onDownloadsChanged(fn)` runs when the download list changes.

## Install

In Nightfeed, open **Addons**.

- **Store** lists approved addons from this repository. Install writes a copy into Nightfeed’s app data.
- **Refresh** checks the store again for newer versions.
- **Installed** is the manager: turn an addon on or off, update it when a newer approved version is available, or remove it. Open an addon from its tab in the left menu.
- **Install from file** accepts a `.zip` or an `addon.json`. That addon is marked as a local file, not as an approved store addon.

Installed addons live in `%AppData%\Nightfeed\addons`.

## Get an addon into the store

Approved addons are the folders under `addons/approved/` plus the list in `addons/catalog.json`.

1. Add `addons/approved/your-id/addon.json` and `index.js`.
2. Add an entry to `addons/catalog.json` with the same `id`, `name`, `version`, `description`, `author`, and `"dir": "approved/your-id"`.
3. Open a pull request. Nightfeed only shows a store addon after that catalog change is on `main`.

The app reads the catalog shipped with the install, then refreshes it from:

`https://raw.githubusercontent.com/remie1529/Nightfeed/main/addons/catalog.json`

A store install downloads `addon.json` and the files it lists from that GitHub path. Nightfeed does not need a new app installer for that download. If GitHub cannot be reached, a first install uses the copy shipped with the app. An update that cannot be downloaded leaves the installed copy in place.

Raise `version` in both `addon.json` and `addons/catalog.json` when you change an approved addon. The store compares that version with the installed one. A higher store version shows **Update** on that addon only. Installing the update replaces that addon’s files and reloads it. Other addons and Nightfeed itself stay as they are.

An addon installed from a file is not checked against the store unless it uses the same `id`. Then the store can still offer **Update**, which replaces the file copy with the approved one.
