import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBackupSnapshot,
  mergeBulkShows,
  prepareImportedBackupData,
  type AppData,
} from '../electron/services/store-logic';
import { DEFAULT_SETTINGS, type LiveTvChannel, type Show } from '../electron/types';

function makeShow(tmdbId: number, name: string, extra: Partial<Show> = {}): Show {
  return {
    id: tmdbId,
    tmdbId,
    name,
    overview: '',
    posterPath: null,
    backdropPath: null,
    firstAirDate: '2024-01-01',
    status: 'Running',
    seasons: [
      {
        seasonNumber: 1,
        name: 'Season 1',
        episodeCount: 1,
        airDate: '2024-01-01',
        posterPath: null,
        episodes: [
          {
            id: tmdbId * 100 + 1,
            seasonNumber: 1,
            episodeNumber: 1,
            name: 'Pilot',
            airDate: '2024-01-01',
            overview: '',
            stillPath: null,
            status: 'missing',
          },
        ],
      },
    ],
    addedAt: '2024-01-01T00:00:00.000Z',
    ...extra,
  };
}

function makeChannel(id: string, extra: Partial<LiveTvChannel> = {}): LiveTvChannel {
  return {
    id,
    name: `Channel ${id}`,
    number: 1,
    group: 'General',
    logo: '',
    tvgId: id,
    url: `http://example.com/${id}.ts`,
    enabled: true,
    ...extra,
  };
}

test('backup export + import round-trips episodeResolutions and Live TV channels without mutating input', () => {
  const customCh = makeChannel('lib-1', {
    name: 'My Movies',
    number: 99,
    url: 'nightfeed://library/lib-1',
    kind: 'library',
    libraryMode: 'random-movies',
  });
  const iptvCh = makeChannel('iptv-1', { number: 1, epgCustom: true, tvgId: '' });

  const original: AppData = {
    settings: { ...DEFAULT_SETTINGS, minSeeders: 12, torrentBlockTv: 'cam\nts' },
    shows: [makeShow(10, 'Test Show')],
    movies: [],
    downloads: [],
    triedTorrents: { 'ep:10:1:1': ['abc123'] },
    episodeOverrides: { '10:1:1': 'ignored' },
    episodeResolutions: { '10:1:1': '1080p', '10:1:2': '2160p' },
    telegramRequests: [],
    downloadHistory: [],
    lastDailyBriefingDate: '2026-11-18',
    liveTvLineup: [iptvCh, customCh],
    liveTvCustomChannels: [customCh],
    liveTvXmltvCache: '<tv/>',
  };

  const snapshot = buildBackupSnapshot(original);
  assert.deepEqual(snapshot.episodeResolutions, { '10:1:1': '1080p', '10:1:2': '2160p' });
  assert.equal(snapshot.liveTvLineup.length, 2);
  assert.equal(snapshot.liveTvCustomChannels.length, 1);
  assert.equal(snapshot.liveTvCustomChannels[0].id, 'lib-1');
  assert.equal(snapshot.liveTvXmltvCache, '');

  // Ensure import does not mutate raw input even when optional fields are missing
  const rawInput = Object.freeze({
    settings: { ...DEFAULT_SETTINGS, telegramAllowedChatIds: '12345' },
    shows: [makeShow(10, 'Test Show')],
    episodeResolutions: { '10:1:1': '720p', '10:1:2': 'invalid-res' },
    liveTvLineup: [iptvCh],
    liveTvCustomChannels: [customCh],
  });

  const { data, counts } = prepareImportedBackupData(rawInput);
  assert.equal(counts.shows, 1);
  assert.equal(counts.movies, 0);
  assert.equal(counts.liveTvChannels, 2);
  assert.deepEqual(data.episodeResolutions, { '10:1:1': '720p' });
  assert.equal(data.liveTvLineup.length, 2);
  assert.equal(data.liveTvCustomChannels.length, 1);
  assert.equal(data.liveTvCustomChannels[0].kind, 'library');
  assert.equal(data.settings.telegramAdminChatIds, '12345');
  assert.equal(data.liveTvLineup[0].epgCustom, true);
  assert.equal(data.liveTvLineup[0].tvgId, '');
});

test('prepareImportedBackupData rejects malformed inputs', () => {
  assert.throws(() => prepareImportedBackupData(null), /not an object/i);
  assert.throws(() => prepareImportedBackupData({ shows: [] }), /missing settings/i);
  assert.throws(() => prepareImportedBackupData({ settings: {} }), /missing shows/i);
});

test('mergeBulkShows preserves concurrent adds, removals, user edits, and finished downloads', () => {
  const show1Live = makeShow(1, 'Show 1', {
    monitored: false,
    preferredResolution: '2160p',
    seasons: [
      {
        seasonNumber: 1,
        name: 'Season 1',
        episodeCount: 1,
        airDate: '2024-01-01',
        posterPath: null,
        episodes: [
          {
            id: 101,
            seasonNumber: 1,
            episodeNumber: 1,
            name: 'Pilot',
            airDate: '2024-01-01',
            overview: '',
            stillPath: null,
            status: 'downloaded',
            localPath: 'D:\\TV\\Show 1\\Season 01\\Show 1 - S01E01.mkv',
            downloadedResolution: '1080p',
          },
        ],
      },
    ],
  });
  const show3Added = makeShow(3, 'Newly Added Show');

  // Show 2 was removed concurrently; Show 3 was added concurrently; Show 1 was edited + got a download
  const liveShows = [show1Live, show3Added];
  const pending = new Map<number, Show>([
    [1, makeShow(1, 'Show 1', { monitored: true, preferredResolution: '1080p', status: 'Ended' })],
    [2, makeShow(2, 'Removed Show')],
  ]);
  const removed = new Set<number>([2]);
  const edited = new Set<number>([1]);

  const merged = mergeBulkShows(liveShows, pending, removed, edited);
  assert.deepEqual(
    merged.map((s) => s.tmdbId),
    [1, 3]
  );
  const mergedShow1 = merged.find((s) => s.tmdbId === 1)!;
  assert.equal(mergedShow1.status, 'Ended');
  assert.equal(mergedShow1.monitored, false);
  assert.equal(mergedShow1.preferredResolution, '2160p');
  assert.equal(mergedShow1.seasons[0].episodes[0].status, 'downloaded');
  assert.equal(
    mergedShow1.seasons[0].episodes[0].localPath,
    'D:\\TV\\Show 1\\Season 01\\Show 1 - S01E01.mkv'
  );
});
