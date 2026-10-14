/**
 * Tools an MCP client can call. Each one uses Nightfeed's own library and downloads.
 * Nothing here reads bot tokens, passwords, or VPN profiles.
 */

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  run: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

export interface NightfeedMcpApi {
  version: string;
  listShows: () => unknown;
  getShow: (mazeId: number) => unknown;
  searchShows: (query: string) => Promise<unknown>;
  addShow: (mazeId: number, policy: 'all' | 'future' | 'manual') => Promise<unknown>;
  removeShow: (mazeId: number) => Promise<unknown>;
  setEpisodeStatus: (
    mazeId: number,
    season: number,
    episode: number,
    status: 'missing' | 'downloaded' | 'ignored' | 'upcoming'
  ) => Promise<unknown>;
  searchEpisodeTorrents: (mazeId: number, season: number, episode: number) => Promise<unknown>;
  downloadEpisode: (input: {
    mazeId: number;
    season: number;
    episode: number;
    magnet?: string;
    ignoreMinSize?: boolean;
  }) => Promise<unknown>;
  listMovies: () => unknown;
  getMovie: (id: number) => unknown;
  searchMovies: (query: string) => Promise<unknown>;
  addMovie: (id: number) => Promise<unknown>;
  removeMovie: (id: number) => Promise<unknown>;
  searchMovieTorrents: (id: number) => Promise<unknown>;
  downloadMovie: (input: { id: number; magnet?: string; ignoreMinSize?: boolean }) => Promise<unknown>;
  listDownloads: () => unknown;
  pauseDownload: (id: string) => unknown;
  resumeDownload: (id: string) => unknown;
  cancelDownload: (id: string) => unknown;
  listRequests: () => unknown;
  resolveRequest: (id: string, action: 'approved' | 'denied') => Promise<unknown>;
  refreshShow: (mazeId: number) => Promise<unknown>;
  refreshMovie: (id: number) => Promise<unknown>;
  status: () => unknown;
}

function num(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

function text(value: unknown, name: string): string {
  const s = String(value || '').trim();
  if (!s) throw new Error(`${name} is required`);
  return s;
}

const obj = { type: 'object' as const, properties: {} };

export function createNightfeedTools(api: NightfeedMcpApi): McpTool[] {
  return [
    {
      name: 'nightfeed_status',
      description: 'Library counts, active downloads, and pending requests.',
      inputSchema: obj,
      run: () => api.status(),
    },
    {
      name: 'nightfeed_list_shows',
      description: 'TV shows in the library. Ids are TVMaze ids.',
      inputSchema: obj,
      run: () => api.listShows(),
    },
    {
      name: 'nightfeed_get_show',
      description: 'One TV show, including seasons and episode statuses.',
      inputSchema: {
        type: 'object',
        properties: { mazeId: { type: 'number', description: 'TVMaze show id' } },
        required: ['mazeId'],
      },
      run: (args) => api.getShow(num(args.mazeId, 'mazeId')),
    },
    {
      name: 'nightfeed_search_shows',
      description: 'Search TVMaze for shows that can be added.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      run: (args) => api.searchShows(text(args.query, 'query')),
    },
    {
      name: 'nightfeed_add_show',
      description: 'Add a TVMaze show. policy future keeps only episodes that have not aired. policy all marks aired episodes wanted. policy manual adds the show without a download policy.',
      inputSchema: {
        type: 'object',
        properties: {
          mazeId: { type: 'number' },
          policy: { type: 'string', enum: ['all', 'future', 'manual'] },
        },
        required: ['mazeId'],
      },
      run: (args) => {
        const policy = String(args.policy || 'manual');
        if (policy !== 'all' && policy !== 'future' && policy !== 'manual') {
          throw new Error('policy must be all, future, or manual');
        }
        return api.addShow(num(args.mazeId, 'mazeId'), policy);
      },
    },
    {
      name: 'nightfeed_remove_show',
      description: 'Remove a TV show from the library. Does not delete video files.',
      inputSchema: {
        type: 'object',
        properties: { mazeId: { type: 'number' } },
        required: ['mazeId'],
      },
      run: (args) => api.removeShow(num(args.mazeId, 'mazeId')),
    },
    {
      name: 'nightfeed_set_episode_status',
      description: 'Set one episode to missing, downloaded, ignored, or upcoming.',
      inputSchema: {
        type: 'object',
        properties: {
          mazeId: { type: 'number' },
          season: { type: 'number' },
          episode: { type: 'number' },
          status: { type: 'string', enum: ['missing', 'downloaded', 'ignored', 'upcoming'] },
        },
        required: ['mazeId', 'season', 'episode', 'status'],
      },
      run: (args) => {
        const status = String(args.status || '');
        if (status !== 'missing' && status !== 'downloaded' && status !== 'ignored' && status !== 'upcoming') {
          throw new Error('status must be missing, downloaded, ignored, or upcoming');
        }
        return api.setEpisodeStatus(num(args.mazeId, 'mazeId'), num(args.season, 'season'), num(args.episode, 'episode'), status);
      },
    },
    {
      name: 'nightfeed_search_episode_torrents',
      description: 'Search torrents for one episode. Results include magnets.',
      inputSchema: {
        type: 'object',
        properties: {
          mazeId: { type: 'number' },
          season: { type: 'number' },
          episode: { type: 'number' },
        },
        required: ['mazeId', 'season', 'episode'],
      },
      run: (args) => api.searchEpisodeTorrents(num(args.mazeId, 'mazeId'), num(args.season, 'season'), num(args.episode, 'episode')),
    },
    {
      name: 'nightfeed_download_episode',
      description: 'Download an episode. Omit magnet to start the top search result. Set ignoreMinSize true only when the user picked that torrent.',
      inputSchema: {
        type: 'object',
        properties: {
          mazeId: { type: 'number' },
          season: { type: 'number' },
          episode: { type: 'number' },
          magnet: { type: 'string' },
          ignoreMinSize: { type: 'boolean' },
        },
        required: ['mazeId', 'season', 'episode'],
      },
      run: (args) => api.downloadEpisode({
        mazeId: num(args.mazeId, 'mazeId'),
        season: num(args.season, 'season'),
        episode: num(args.episode, 'episode'),
        magnet: args.magnet ? String(args.magnet) : undefined,
        ignoreMinSize: args.ignoreMinSize === true,
      }),
    },
    {
      name: 'nightfeed_list_movies',
      description: 'Movies in the library. The id is the IMDb number (tt1375666 is 1375666).',
      inputSchema: obj,
      run: () => api.listMovies(),
    },
    {
      name: 'nightfeed_get_movie',
      description: 'One movie in the library.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number', description: 'IMDb numeric id' } },
        required: ['id'],
      },
      run: (args) => api.getMovie(num(args.id, 'id')),
    },
    {
      name: 'nightfeed_search_movies',
      description: 'Search for movies that can be added.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      run: (args) => api.searchMovies(text(args.query, 'query')),
    },
    {
      name: 'nightfeed_add_movie',
      description: 'Add a movie by its IMDb number (tt1375666 is 1375666).',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
      },
      run: (args) => api.addMovie(num(args.id, 'id')),
    },
    {
      name: 'nightfeed_remove_movie',
      description: 'Remove a movie from the library. Does not delete the video file.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
      },
      run: (args) => api.removeMovie(num(args.id, 'id')),
    },
    {
      name: 'nightfeed_search_movie_torrents',
      description: 'Search torrents for a movie that is already in the library.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
      },
      run: (args) => api.searchMovieTorrents(num(args.id, 'id')),
    },
    {
      name: 'nightfeed_download_movie',
      description: 'Download a movie that is already in the library. Omit magnet to start the top search result. Set ignoreMinSize true only when the user picked that torrent.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          magnet: { type: 'string' },
          ignoreMinSize: { type: 'boolean' },
        },
        required: ['id'],
      },
      run: (args) => api.downloadMovie({
        id: num(args.id, 'id'),
        magnet: args.magnet ? String(args.magnet) : undefined,
        ignoreMinSize: args.ignoreMinSize === true,
      }),
    },
    {
      name: 'nightfeed_list_downloads',
      description: 'Current download queue.',
      inputSchema: obj,
      run: () => api.listDownloads(),
    },
    {
      name: 'nightfeed_pause_download',
      description: 'Pause one download by its id from nightfeed_list_downloads.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      run: (args) => api.pauseDownload(text(args.id, 'id')),
    },
    {
      name: 'nightfeed_resume_download',
      description: 'Resume one paused download.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      run: (args) => api.resumeDownload(text(args.id, 'id')),
    },
    {
      name: 'nightfeed_cancel_download',
      description: 'Cancel one download and remove its files from the queue.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      run: (args) => api.cancelDownload(text(args.id, 'id')),
    },
    {
      name: 'nightfeed_list_requests',
      description: 'TV, movie, and music requests waiting for a decision.',
      inputSchema: obj,
      run: () => api.listRequests(),
    },
    {
      name: 'nightfeed_resolve_request',
      description: 'Approve or deny a request. Approving a TV show or movie adds it and can start a download. Approving music asks the Music addon to download it.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          action: { type: 'string', enum: ['approved', 'denied'] },
        },
        required: ['id', 'action'],
      },
      run: (args) => {
        const action = String(args.action || '');
        if (action !== 'approved' && action !== 'denied') throw new Error('action must be approved or denied');
        return api.resolveRequest(text(args.id, 'id'), action);
      },
    },
    {
      name: 'nightfeed_refresh_show',
      description: 'Refresh metadata for one TV show.',
      inputSchema: {
        type: 'object',
        properties: { mazeId: { type: 'number' } },
        required: ['mazeId'],
      },
      run: (args) => api.refreshShow(num(args.mazeId, 'mazeId')),
    },
    {
      name: 'nightfeed_refresh_movie',
      description: 'Refresh metadata for one movie.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
      },
      run: (args) => api.refreshMovie(num(args.id, 'id')),
    },
  ];
}
