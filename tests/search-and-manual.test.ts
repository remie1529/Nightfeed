import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterQualityResults,
  filterUpgradeResults,
  isMultiEpisodePack,
  titleMatchesMovieYear,
  titleMatchesShow,
  torrentTitleBlocked,
} from '../electron/services/search';
import {
  movieGuessFromTorrentName,
  parseEpisodeTag,
  pickMovieHit,
  showGuessFromTorrentName,
} from '../electron/services/manual-torrent';

test('titleMatchesShow enforces whole-word matching for numbered/short shows (9-1-1)', () => {
  assert.equal(titleMatchesShow('9-1-1.S10E01.1080p.WEB.h264', '9-1-1'), true);
  assert.equal(titleMatchesShow('911.S10E01.1080p.WEB.h264', '9-1-1'), true);
  assert.equal(titleMatchesShow('South.Park.1997.S10E01.2160p.WEB-DL', '9-1-1'), false);
});

test('torrentTitleBlocked matches phrases and tokens case-insensitively', () => {
  assert.equal(torrentTitleBlocked('Movie.2026.CAM.x264', 'cam, telesync'), true);
  assert.equal(torrentTitleBlocked('Movie.2026.1080p.BluRay', 'cam, telesync'), false);
});

test('manual torrent movie guessing respects year so The Odyssey (2026) never picks 1954', () => {
  const guess = movieGuessFromTorrentName('The.Odyssey.(2026).1080p.WEB-DL.x264');
  assert.equal(guess.title, 'The Odyssey');
  assert.equal(guess.year, 2026);

  const hit = pickMovieHit(
    [{ id: 47630, title: 'The Odyssey', releaseYear: 1954 }],
    guess.title,
    guess.year
  );
  assert.equal(hit, null);

  const exactHit = pickMovieHit(
    [
      { id: 47630, title: 'The Odyssey', releaseYear: 1954 },
      { id: 33764258, title: 'The Odyssey', releaseYear: 2026 },
    ],
    guess.title,
    guess.year
  );
  assert.equal(exactHit?.id, 33764258);
});

test('parseEpisodeTag handles SxxExx and NxNN formats', () => {
  assert.deepEqual(parseEpisodeTag('Show.S02E05.1080p.mkv'), { season: 2, episode: 5 });
  assert.deepEqual(parseEpisodeTag('Show.2x05.720p.mkv'), { season: 2, episode: 5 });
  assert.equal(parseEpisodeTag('The.Matrix.1999.1080p.BluRay.mkv'), null);
});

test('titleMatchesMovieYear allows year-titled movies like Blade Runner 2049 (2017) and 1917 (2019)', () => {
  assert.equal(
    titleMatchesMovieYear('Blade.Runner.2049.2017.1080p.BluRay', 2017, 'Blade Runner 2049'),
    true
  );
  assert.equal(
    titleMatchesMovieYear('Blade.Runner.1982.1080p.BluRay', 2017, 'Blade Runner 2049'),
    false
  );
  assert.equal(
    titleMatchesMovieYear('1917.2019.2160p.UHD.BluRay', 2019, '1917'),
    true
  );
  assert.equal(
    titleMatchesMovieYear('The.Odyssey.1954.1080p.BluRay', 2026, 'The Odyssey'),
    false
  );
});

test('isMultiEpisodePack does not false-match single episode titles containing to 1080p', () => {
  assert.equal(isMultiEpisodePack('Show.S01E01-E03.1080p.WEB-DL'), true);
  assert.equal(isMultiEpisodePack('Show.S01E01.to.S01E04.1080p.WEB-DL'), true);
  assert.equal(isMultiEpisodePack('Show.S01E05.to.1080p.WEB-DL'), false);
  assert.equal(isMultiEpisodePack('Show.S01E05.Back.to.1080p.WEB-DL'), false);
});

test('filterQualityResults and filterUpgradeResults reject junk releases (CAM/TS/Sample)', () => {
  const cam = {
    title: 'New.Movie.2026.1080p.HDCAM.x264',
    magnet: 'magnet:?xt=urn:btih:1111111111111111111111111111111111111111',
    size: 2 * 1024 * 1024 * 1024,
    seeders: 50,
    leechers: 10,
    source: 'apibay',
    resolution: '1080p' as const,
  };
  const clean = {
    ...cam,
    title: 'New.Movie.2026.1080p.BluRay.x264',
  };
  assert.equal(filterQualityResults([cam, clean], '1080p', 'movie').length, 1);
  assert.equal(filterUpgradeResults([cam, clean], '1080p', 'movie').length, 1);
});

test('manual torrent guessing handles show episode titles and year-titled movies', () => {
  assert.equal(
    showGuessFromTorrentName('Breaking.Bad.S01E01.Pilot.1080p.BluRay.x264'),
    'Breaking Bad'
  );
  assert.equal(
    showGuessFromTorrentName('The.Bear.2x07.Forks.1080p.WEB-DL'),
    'The Bear'
  );
  assert.deepEqual(
    movieGuessFromTorrentName('Blade.Runner.2049.(2017).1080p.BluRay'),
    { title: 'Blade Runner 2049', year: 2017 }
  );
  assert.deepEqual(
    movieGuessFromTorrentName('Blade.Runner.2049.2017.1080p.BluRay'),
    { title: 'Blade Runner 2049', year: 2017 }
  );
});
