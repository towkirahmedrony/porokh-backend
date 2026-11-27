/**
 * Level and track filters for the admin question list.
 *
 * A question's level is never stored. It is derived from the preparation tracks
 * a question carries: any of varsity, medical, engineering or admission makes it
 * admission level, and hsc alone makes it HSC level. So the admin filter has one
 * real dimension (the track) and one shortcut (the level), and the shortcut is
 * translated into tracks here rather than in the query builder.
 *
 * `untracked` and `conflicting` are not tracks. They are the two lists that need
 * a human, and they come from get_question_level_report() so the admin screen and
 * the bank agree on what "untracked" means.
 */

export const PREPARATION_TRACK_IDS = [
  'hsc',
  'varsity',
  'medical',
  'engineering',
  'admission',
] as const;

export type PreparationTrackId = (typeof PREPARATION_TRACK_IDS)[number];

/** Tracks that make a question admission level. */
export const ADMISSION_TRACK_IDS: readonly PreparationTrackId[] = [
  'varsity',
  'medical',
  'engineering',
  'admission',
];

export const ATTENTION_BUCKETS = [
  'untracked',
  'manual_admission_without_reference',
  'university_reference_without_admission_track',
  'blank_institution_reference',
] as const;

export type AttentionBucket = (typeof ATTENTION_BUCKETS)[number];

/** The buckets the "conflicting" filter stands for. */
export const CONFLICT_BUCKETS: readonly AttentionBucket[] = [
  'manual_admission_without_reference',
  'university_reference_without_admission_track',
];

export type QuestionLevel = 'hsc' | 'admission';

const TRACK_ALIASES: Record<string, PreparationTrackId | 'untracked' | 'conflicting'> = {
  hsc: 'hsc',
  varsity: 'varsity',
  medical: 'medical',
  engineering: 'engineering',
  admission: 'admission',
  untracked: 'untracked',
  no_track: 'untracked',
  none: 'untracked',
  conflicting: 'conflicting',
  conflict: 'conflicting',
};

export class LevelFilterValidationError extends Error {
  status = 400;
  errorCode = 'VALIDATION_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'LevelFilterValidationError';
  }
}

export const levelOfTrack = (track: PreparationTrackId): QuestionLevel =>
  track === 'hsc' ? 'hsc' : 'admission';

export interface ResolvedLevelFilter {
  /** Null means "every level". */
  level: QuestionLevel | null;
  /** Tracks the question must carry at least one of. Empty means no constraint. */
  tracks: PreparationTrackId[];
  /** Attention buckets to include. Empty means no constraint. */
  buckets: AttentionBucket[];
}

const EMPTY: ResolvedLevelFilter = { level: null, tracks: [], buckets: [] };

const readLevel = (value: unknown): QuestionLevel | null | 'invalid' => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return 'invalid';

  const raw = value.trim().toLowerCase();
  if (raw === '' || raw === 'all') return null;
  if (raw === 'hsc') return 'hsc';
  if (raw === 'admission') return 'admission';

  return 'invalid';
};

/**
 * Reads the two filters an admin screen sends.
 *
 * An absent filter means "no constraint". An unknown value is an error rather
 * than a silent fallback, because a typo that quietly widens the list is how an
 * admin ends up bulk-tagging the wrong questions.
 */
export const parseLevelFilter = (
  levelValue: unknown,
  trackValue: unknown
): ResolvedLevelFilter => {
  const level = readLevel(levelValue);
  if (level === 'invalid') {
    throw new LevelFilterValidationError('level must be hsc, admission, or empty.');
  }

  let track: PreparationTrackId | 'untracked' | 'conflicting' | null = null;
  if (trackValue !== undefined && trackValue !== null) {
    if (typeof trackValue !== 'string') {
      throw new LevelFilterValidationError('track must be a string.');
    }
    const raw = trackValue.trim().toLowerCase();
    if (raw !== '' && raw !== 'all') {
      const resolved = TRACK_ALIASES[raw];
      if (!resolved) {
        throw new LevelFilterValidationError(
          'track must be one of hsc, varsity, medical, engineering, admission, untracked, conflicting.'
        );
      }
      track = resolved;
    }
  }

  if (track === null) {
    if (level === null) return EMPTY;
    return {
      level,
      tracks: level === 'hsc' ? ['hsc'] : [...ADMISSION_TRACK_IDS],
      buckets: [],
    };
  }

  if (track === 'untracked') {
    if (level !== null) {
      throw new LevelFilterValidationError(
        'An untracked question has no level yet, so it cannot be combined with a level filter.'
      );
    }
    return { level: null, tracks: [], buckets: ['untracked'] };
  }

  if (track === 'conflicting') {
    if (level !== null) {
      throw new LevelFilterValidationError(
        'A conflicting question is reported by reference, not by level, so drop the level filter.'
      );
    }
    return { level: null, tracks: [], buckets: [...CONFLICT_BUCKETS] };
  }

  const trackLevel = levelOfTrack(track);
  if (level !== null && level !== trackLevel) {
    throw new LevelFilterValidationError(
      `track ${track} is ${trackLevel} level, which contradicts level ${level}.`
    );
  }

  return { level: trackLevel, tracks: [track], buckets: [] };
};

export const trackLabel = (track: PreparationTrackId): string =>
  ({
    hsc: 'এইচএসসি',
    varsity: 'ভর্তি · ভার্সিটি',
    medical: 'ভর্তি · মেডিকেল',
    engineering: 'ভার্সিটি · ইঞ্জিনিয়ারিং',
    admission: 'ভর্তি · সাধারণ',
  })[track];

export const levelLabel = (level: QuestionLevel): string =>
  level === 'hsc' ? 'এইচএসসি' : 'ভর্তি';

/**
 * The tags on a question that disagree with its reference data.
 *
 * Without a university reference an admission tag is a manual override, which is
 * allowed but worth showing. With one, a question that lacks any admission tag
 * has drifted from the rule. `hsc` next to an admission tag is not a conflict:
 * that pair is the documented dual placement.
 */
export const conflictingTracks = (
  tracks: readonly string[],
  hasUniversityReference: boolean
): string[] => {
  const admissionTracks = tracks.filter((track) =>
    (ADMISSION_TRACK_IDS as readonly string[]).includes(track)
  );

  if (!hasUniversityReference) return admissionTracks;

  return admissionTracks.length > 0 ? [] : tracks.filter((track) => track !== 'hsc');
};
