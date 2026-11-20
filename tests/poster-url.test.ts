import test from 'node:test';
import assert from 'node:assert/strict';
import { sizePosterUrl } from '../electron/services/poster-url';

test('sizePosterUrl rewrites raw IMDb/Amazon posters to crisp sized URLs', () => {
  const raw =
    'https://m.media-amazon.com/images/M/MV5BN2NmN2VhMTQtMDNiOS00NDlhLTliMjgtODE2ZTY0ODQyNDRhXkEyXkFqcGc@._V1_.jpg';
  assert.equal(
    sizePosterUrl(raw, 'thumb'),
    'https://m.media-amazon.com/images/M/MV5BN2NmN2VhMTQtMDNiOS00NDlhLTliMjgtODE2ZTY0ODQyNDRhXkEyXkFqcGc@._V1_QL80_UX140_.jpg'
  );
  assert.equal(
    sizePosterUrl(raw, 'w342'),
    'https://m.media-amazon.com/images/M/MV5BN2NmN2VhMTQtMDNiOS00NDlhLTliMjgtODE2ZTY0ODQyNDRhXkEyXkFqcGc@._V1_QL82_UX360_.jpg'
  );
  assert.equal(
    sizePosterUrl(raw, 'w500'),
    'https://m.media-amazon.com/images/M/MV5BN2NmN2VhMTQtMDNiOS00NDlhLTliMjgtODE2ZTY0ODQyNDRhXkEyXkFqcGc@._V1_QL85_UX560_.jpg'
  );
});

test('sizePosterUrl upgrades tiny pixelated IMDb thumbnails and leaves non-IMDb URLs intact', () => {
  const tiny =
    'https://m.media-amazon.com/images/M/MV5BTEST._V1_UX32_CR0,0,32,44_AL_.jpg';
  assert.equal(
    sizePosterUrl(tiny, 'w342'),
    'https://m.media-amazon.com/images/M/MV5BTEST._V1_QL82_UX360_.jpg'
  );
  const tvmaze = 'https://static.tvmaze.com/uploads/images/medium_portrait/1/2345.jpg';
  assert.equal(sizePosterUrl(tvmaze, 'w342'), tvmaze);
  assert.equal(sizePosterUrl(null, 'w342'), null);
  assert.equal(sizePosterUrl('', 'w342'), null);
});
