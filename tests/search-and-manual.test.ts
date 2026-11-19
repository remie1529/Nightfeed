import test from 'node:test';
import assert from 'node:assert/strict';
import {
  titleMatchesShow,
  torrentTitleBlocked,
} from '../electron/services/search';
import {
  movieGuessFromTorrentName,
  parseEpisodeTag,
  pickMovieHit,
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
