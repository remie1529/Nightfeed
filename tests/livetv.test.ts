import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'zlib';
import type { LiveTvChannel } from '../electron/types';
import {
  buildScheduleFromItems,
  type LibraryMediaItem,
} from '../electron/services/library-schedule-core';
import {
  buildFfmpegHeadersArg,
  indexXmltvProgrammes,
  parseHlsPlaylist,
  parseStreamTarget,
  parseXmltvChannels,
  rewriteProgrammeChannel,
} from '../electron/services/livetv-xmltv';
import { decodeResponseBody, parseM3u } from '../electron/services/livetv-refresh-core';

function makeLibraryChannel(overrides: Partial<LiveTvChannel> = {}): LiveTvChannel {
  return {
    id: 'lib-test',
    name: 'Test Channel',
    number: 100,
    group: 'Nightfeed',
    logo: '',
    tvgId: 'nf-lib-test',
    url: 'nightfeed://library/lib-test',
    enabled: true,
    kind: 'library',
    libraryMode: 'show',
    showTmdbId: 42,
    ...overrides,
  };
}

test('One show, in order plays strictly S01E01 -> S01E02 -> S02E01 without shuffling', () => {
  const ch = makeLibraryChannel({ libraryMode: 'show' });
  const items: LibraryMediaItem[] = [
    { path: '/s2e1.mkv', title: 'Show S02E01', desc: '', durationSec: 1320, sortKey: '2024-01-01', seasonNumber: 2, episodeNumber: 1 },
    { path: '/s1e2.mkv', title: 'Show S01E02', desc: '', durationSec: 1320, sortKey: '2023-01-08', seasonNumber: 1, episodeNumber: 2 },
    { path: '/s1e1.mkv', title: 'Show S01E01', desc: '', durationSec: 1320, sortKey: '2023-01-01', seasonNumber: 1, episodeNumber: 1 },
  ];
  const from = Date.UTC(2026, 5, 10, 0, 0, 0);
  const slots = buildScheduleFromItems(ch, items, from, 1);
  assert.ok(slots.length >= 6);
  const firstIdx = slots.findIndex((s) => s.title === 'Show S01E01');
  assert.ok(firstIdx >= 0);
  assert.equal(slots[firstIdx].title, 'Show S01E01');
  assert.equal(slots[firstIdx + 1].title, 'Show S01E02');
  assert.equal(slots[firstIdx + 2].title, 'Show S02E01');
  assert.equal(slots[firstIdx + 3].title, 'Show S01E01');
  // Real duration preserved (22 minutes = 1,320,000 ms, not hardcoded 45 minutes)
  assert.equal(slots[firstIdx].end - slots[firstIdx].start, 1320 * 1000);
});

test('Library schedule stays continuous across midnight without jumping', () => {
  const ch = makeLibraryChannel({ libraryMode: 'random-mix' });
  const items: LibraryMediaItem[] = [
    { path: '/a.mkv', title: 'Movie A', desc: '', durationSec: 5400, sortKey: '2024-01-01' },
    { path: '/b.mkv', title: 'Episode B', desc: '', durationSec: 1380, sortKey: '2024-02-01' },
    { path: '/c.mkv', title: 'Movie C', desc: '', durationSec: 6300, sortKey: '2024-03-01' },
  ];
  const day1Start = Date.UTC(2026, 5, 10, 0, 0, 0);
  const day2Start = Date.UTC(2026, 5, 11, 0, 0, 0);
  const day1Slots = buildScheduleFromItems(ch, items, day1Start, 2);
  const day2Slots = buildScheduleFromItems(ch, items, day2Start, 2);

  const checkTime = day2Start + 5 * 60 * 1000; // 00:05 on day 2
  const fromDay1 = day1Slots.find((s) => checkTime >= s.start && checkTime < s.end);
  const fromDay2 = day2Slots.find((s) => checkTime >= s.start && checkTime < s.end);
  assert.ok(fromDay1 && fromDay2);
  assert.equal(fromDay1.path, fromDay2.path);
  assert.equal(fromDay1.start, fromDay2.start);
  assert.equal(fromDay1.end, fromDay2.end);
});

test('XMLTV parser handles single/double quotes, XML entities, and channel aliasing', () => {
  const xml = `<?xml version="1.0"?>
<tv>
  <channel id='ch&amp;1'><display-name>News &amp; Sports</display-name></channel>
  <channel id="ch2"><display-name>Movies</display-name></channel>
  <programme start="20260101000000 +0000" stop="20260101010000 +0000" channel='ch&amp;1'><title>Show A</title></programme>
  <programme start="20260101010000 +0000" stop="20260101020000 +0000" channel="ch&amp;1"><title>Show B</title></programme>
</tv>`;
  const channels = parseXmltvChannels(xml);
  assert.deepEqual(channels, [
    { id: 'ch2', name: 'Movies' },
    { id: 'ch&1', name: 'News & Sports' },
  ]);
  const progs = indexXmltvProgrammes(xml);
  const p = progs.get('ch&1') || '';
  assert.ok(p.includes('Show A') && p.includes('Show B'));
  const rewritten = rewriteProgrammeChannel(p, 'nf-dup-1');
  assert.ok(!rewritten.includes('ch&amp;1'));
  assert.ok(rewritten.includes('channel="nf-dup-1"'));
});

test('Gzipped XMLTV and M3U parsing with duplicate URLs and EXTVLCOPT headers', () => {
  const rawXml = '<tv><channel id="a"><display-name>A</display-name></channel></tv>';
  const gz = zlib.gzipSync(Buffer.from(rawXml, 'utf8'));
  assert.equal(decodeResponseBody(gz, '', 'https://example.com/epg.xml.gz'), rawXml);
  assert.equal(decodeResponseBody(gz, 'gzip', 'https://example.com/epg'), rawXml);
  assert.equal(decodeResponseBody(Buffer.from(rawXml, 'utf8'), '', 'https://example.com/epg.xml'), rawXml);

  const m3u = [
    '#EXTM3U',
    "#EXTINF:-1 tvg-id='ch1' group-title='News',Channel One",
    '#EXTVLCOPT:http-user-agent=CustomUA/1.0',
    '#EXTVLCOPT:http-origin=https://origin.example',
    '#EXTVLCOPT:http-referrer=https://ref.example/page',
    'https://stream.example/live.m3u8',
    '#EXTINF:-1 tvg-id="ch1-dup" group-title="News",Channel One Backup',
    'https://stream.example/live.m3u8',
  ].join('\n');
  const parsed = parseM3u(m3u);
  assert.equal(parsed.length, 2);
  assert.notEqual(parsed[0].id, parsed[1].id);
  const target = parseStreamTarget(parsed[0].url);
  assert.equal(target.headers['User-Agent'], 'CustomUA/1.0');
  assert.equal(target.headers['Origin'], 'https://origin.example');
  assert.equal(target.headers['Referer'], 'https://ref.example/page');

  const ffHeaders = buildFfmpegHeadersArg({
    'User-Agent': 'IgnoreMe',
    Referer: 'https://ref.example/page\r\nEvil: injected',
    Origin: 'https://origin.example',
  });
  const headerLines = ffHeaders.split('\r\n').filter(Boolean);
  assert.equal(headerLines.length, 2);
  assert.ok(!headerLines.some((l) => /^User-Agent:/i.test(l)));
  assert.ok(!headerLines.some((l) => /^Evil:/i.test(l)));
  assert.ok(headerLines.includes('Origin: https://origin.example'));
});

test('HLS playlist parser detects variants, fMP4, and AES-128 encryption', () => {
  const master = parseHlsPlaylist(
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1200000\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=4800000\nhigh.m3u8\n',
    'https://cdn.example/live/master.m3u8'
  );
  assert.equal(master.variants.length, 2);
  assert.equal(master.variants[1].url, 'https://cdn.example/live/high.m3u8');

  const enc = parseHlsPlaylist(
    '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4,\nseg1.ts\n',
    'https://cdn.example/live/high.m3u8'
  );
  assert.equal(enc.encrypted, true);
  assert.equal(enc.fmp4, false);

  const plain = parseHlsPlaylist(
    '#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg1.m4s\n',
    'https://cdn.example/live/high.m3u8'
  );
  assert.equal(plain.encrypted, false);
  assert.equal(plain.fmp4, true);
});
