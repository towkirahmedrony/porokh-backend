import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ADMISSION_TRACK_IDS,
  CONFLICT_BUCKETS,
  LevelFilterValidationError,
  conflictingTracks,
  levelOfTrack,
  parseLevelFilter,
} from './question.level';

test('no filter constrains nothing', () => {
  for (const empty of [undefined, null, '', 'all', 'ALL']) {
    assert.deepEqual(parseLevelFilter(empty, empty), {
      level: null,
      tracks: [],
      buckets: [],
    });
  }
});

test('the HSC level resolves to the hsc track', () => {
  assert.deepEqual(parseLevelFilter('hsc', undefined), {
    level: 'hsc',
    tracks: ['hsc'],
    buckets: [],
  });
  assert.deepEqual(parseLevelFilter('HSC', undefined).tracks, ['hsc']);
});

test('the admission level resolves to every admission track', () => {
  const resolved = parseLevelFilter('admission', undefined);

  assert.equal(resolved.level, 'admission');
  assert.deepEqual(resolved.tracks, [...ADMISSION_TRACK_IDS]);
  assert.deepEqual(resolved.buckets, []);
});

test('a track pins the level with it', () => {
  assert.deepEqual(parseLevelFilter(undefined, 'varsity'), {
    level: 'admission',
    tracks: ['varsity'],
    buckets: [],
  });
  assert.deepEqual(parseLevelFilter(undefined, 'hsc'), {
    level: 'hsc',
    tracks: ['hsc'],
    buckets: [],
  });
});

test('a level that contradicts the track is rejected instead of narrowed silently', () => {
  assert.throws(
    () => parseLevelFilter('hsc', 'medical'),
    (error: unknown) =>
      error instanceof LevelFilterValidationError && /contradicts/.test(error.message)
  );

  assert.deepEqual(parseLevelFilter('admission', 'medical').tracks, ['medical']);
});

test('an unknown track or level is an error', () => {
  assert.throws(() => parseLevelFilter(undefined, 'physics'), LevelFilterValidationError);
  assert.throws(() => parseLevelFilter(undefined, 'admission-admission'), LevelFilterValidationError);
  assert.throws(() => parseLevelFilter('post_hsc', undefined), LevelFilterValidationError);
  assert.throws(() => parseLevelFilter(42, undefined), LevelFilterValidationError);
});

test('untracked and conflicting are buckets, not tracks', () => {
  assert.deepEqual(parseLevelFilter(undefined, 'untracked'), {
    level: null,
    tracks: [],
    buckets: ['untracked'],
  });
  assert.deepEqual(parseLevelFilter(undefined, 'no_track').buckets, ['untracked']);

  assert.deepEqual(parseLevelFilter(undefined, 'conflicting'), {
    level: null,
    tracks: [],
    buckets: [...CONFLICT_BUCKETS],
  });
});

test('a bucket cannot be combined with a level', () => {
  assert.throws(() => parseLevelFilter('hsc', 'untracked'), LevelFilterValidationError);
  assert.throws(() => parseLevelFilter('admission', 'conflicting'), LevelFilterValidationError);
});

test('levelOfTrack treats everything except hsc as admission', () => {
  assert.equal(levelOfTrack('hsc'), 'hsc');
  for (const track of ADMISSION_TRACK_IDS) {
    assert.equal(levelOfTrack(track), 'admission');
  }
});

test('a dual hsc plus medical placement reports only the admission tag', () => {
  // The pair is the documented dual placement, so hsc must never be reported.
  assert.deepEqual(conflictingTracks(['hsc', 'medical'], false), ['medical']);
  assert.deepEqual(conflictingTracks(['hsc'], false), []);
});

test('a university reference with no admission tag is reported', () => {
  assert.deepEqual(conflictingTracks([], true), []);
  assert.deepEqual(conflictingTracks(['hsc'], true), []);
});

test('a manual admission tag without any reference is reported', () => {
  assert.deepEqual(conflictingTracks(['varsity'], false), ['varsity']);
  assert.deepEqual(conflictingTracks(['hsc', 'admission'], false), ['admission']);
});
