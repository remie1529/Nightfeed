import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  findLocalEpisode,
  findLocalMovie,
  getMovieRoot,
  sanitizeName,
} from '../electron/services/paths';
import { buildScanPreview } from '../electron/services/library-scan';
import { writeMovieNfos } from '../electron/services/nfo';
import type { Movie, Show } from '../electron/types';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeMovie(tmdbId: number, title: string, releaseYear: number, extra: Partial<Movie> = {}): Movie {
  return {
    id: tmdbId,
    tmdbId,
    title,
    overview: '',
    imdbId: `tt${String(tmdbId).padStart(7, '0')}`,
    posterPath: null,
    backdropPath: null,
    releaseDate: `${releaseYear}-01-01`,
    releaseYear,
    runtime: 120,
    status: 'missing',
    addedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

test('sanitizeName strips trailing dots and guards Windows reserved names', () => {
  assert.equal(sanitizeName('What If...?'), 'What If');
  assert.equal(sanitizeName('  CON  '), 'CON_');
  assert.equal(sanitizeName('nul'), 'nul_');
  assert.equal(sanitizeName('...'), 'Untitled');
  assert.equal(sanitizeName('Foo: Bar / Baz'), 'Foo Bar Baz');
});

test('findLocalEpisode does not false-match S1E1 against S1E10', () => {
  const root = makeTempDir('nf-ep-');
  try {
    const seasonDir = path.join(root, 'My Show', 'Season 01');
    fs.mkdirSync(seasonDir, { recursive: true });
    fs.writeFileSync(path.join(seasonDir, 'My Show S1E10.mkv'), 'x');

    const show: Show = {
      id: 1,
      tmdbId: 1,
      name: 'My Show',
      overview: '',
      posterPath: null,
      backdropPath: null,
      firstAirDate: null,
      status: 'Running',
      seasons: [],
      addedAt: '',
    };

    assert.equal(findLocalEpisode(show, root, 1, 1), undefined);
    assert.equal(
      findLocalEpisode(show, root, 1, 10),
      path.join(seasonDir, 'My Show S1E10.mkv')
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loose movies in a shared root resolve independently and do not poison folder scan', async () => {
  const movieRoot = makeTempDir('nf-movies-');
  try {
    const inceptionFile = path.join(movieRoot, 'Inception (2010).mkv');
    const matrixFile = path.join(movieRoot, 'The Matrix (1999).mkv');
    fs.writeFileSync(inceptionFile, 'a');
    fs.writeFileSync(matrixFile, 'b');

    // Simulate a legacy tracked movie whose libraryPath was saved as movieRoot, plus a new loose movie
    const inceptionLegacy = makeMovie(1375666, 'Inception', 2010, { libraryPath: movieRoot });
    const matrixTracked = makeMovie(133093, 'The Matrix', 1999, { localPath: matrixFile });
    const unrelatedMissing = makeMovie(999999, 'Interstellar', 2014);

    assert.equal(findLocalMovie(inceptionLegacy, movieRoot), inceptionFile);
    assert.equal(findLocalMovie(matrixTracked, movieRoot), matrixFile);
    assert.equal(findLocalMovie(unrelatedMissing, movieRoot), undefined);

    // getMovieRoot must not return the shared root for a legacy loose import
    assert.equal(
      getMovieRoot(inceptionLegacy, movieRoot),
      path.join(movieRoot, 'Inception (2010)')
    );

    // Scanning when only Inception (legacy libraryPath=movieRoot) is tracked must still find The Matrix as will_add
    const preview = await buildScanPreview(
      'movies',
      '',
      movieRoot,
      [],
      [inceptionLegacy],
      undefined,
      {
        searchShows: async () => [],
        searchMovies: async (q) => {
          if (q.toLowerCase().includes('matrix')) {
            return [
              {
                id: 133093,
                title: 'The Matrix',
                overview: '',
                posterUrl: null,
                backdropUrl: null,
                releaseDate: '1999-03-31',
                releaseYear: 1999,
              },
            ];
          }
          return [];
        },
      }
    );

    const incCand = preview.candidates.find((c) => c.folderName === 'Inception (2010).mkv')!;
    const matCand = preview.candidates.find((c) => c.folderName === 'The Matrix (1999).mkv')!;
    assert.equal(incCand.status, 'already_in_library');
    assert.equal(incCand.folderPath, inceptionFile);
    assert.equal(matCand.status, 'will_add');
    assert.equal(matCand.folderPath, matrixFile);
    assert.equal(matCand.matchId, 133093);

    // writeMovieNfos for a loose movie directly in movieRoot must not write a shared movie.nfo
    const written = await writeMovieNfos({
      movie: matrixTracked,
      videoPath: matrixFile,
    });
    assert.equal(written.length, 2); // without movieLibraryRoot hint it uses dirname
    const writtenWithRoot = await writeMovieNfos({
      movie: makeMovie(133093, 'The Matrix', 1999),
      videoPath: matrixFile,
      movieLibraryRoot: movieRoot,
    });
    // When movieLibraryRoot is passed, getMovieRoot points to dedicated subfolder or skips shared root
    assert.ok(writtenWithRoot.some((p) => p.endsWith('The Matrix (1999).nfo')));
  } finally {
    fs.rmSync(movieRoot, { recursive: true, force: true });
  }
});
