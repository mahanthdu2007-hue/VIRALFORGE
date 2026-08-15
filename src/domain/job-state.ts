/**
 * Job lifecycle.
 *
 * One state enum covers both analysis and render jobs; a job type simply never
 * visits the states that do not apply to it. Transitions are declared as an
 * explicit adjacency map so an illegal move is a caught error rather than a
 * silently corrupt job.
 */

export const JOB_STATES = [
  'QUEUED',
  'UPLOADING',
  'ANALYZING',
  'TRANSCRIBING',
  'FINDING_CLIPS',
  'BUILDING_CLIPS',
  'RENDERING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export type JobState = (typeof JOB_STATES)[number];

/** States from which no further transition is possible. */
export const TERMINAL_JOB_STATES = ['COMPLETED', 'FAILED', 'CANCELLED'] as const satisfies readonly JobState[];

export type TerminalJobState = (typeof TERMINAL_JOB_STATES)[number];

export const isJobState = (value: unknown): value is JobState =>
  typeof value === 'string' && (JOB_STATES as readonly string[]).includes(value);

export const isTerminalJobState = (state: JobState): state is TerminalJobState =>
  (TERMINAL_JOB_STATES as readonly JobState[]).includes(state);

/**
 * Allowed successors per state.
 *
 * Every non-terminal state can fail or be cancelled. The happy path is the
 * pipeline order; skipping forward is allowed only where a stage is genuinely
 * optional, which is nowhere today — so the path is strict.
 */
export const JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  QUEUED: ['UPLOADING', 'ANALYZING', 'RENDERING', 'FAILED', 'CANCELLED'],
  UPLOADING: ['ANALYZING', 'FAILED', 'CANCELLED'],
  ANALYZING: ['TRANSCRIBING', 'FAILED', 'CANCELLED'],
  TRANSCRIBING: ['FINDING_CLIPS', 'FAILED', 'CANCELLED'],
  // COMPLETED is reachable here because a discovery-only analysis (Phase 2)
  // legitimately finishes once candidates are persisted; clip construction is a
  // separate concern that will run as its own stage.
  FINDING_CLIPS: ['BUILDING_CLIPS', 'COMPLETED', 'FAILED', 'CANCELLED'],
  BUILDING_CLIPS: ['COMPLETED', 'RENDERING', 'FAILED', 'CANCELLED'],
  RENDERING: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export const canTransition = (from: JobState, to: JobState): boolean =>
  JOB_TRANSITIONS[from].includes(to);

/**
 * Human-facing copy for each state. Lives in the domain so the API and the UI
 * cannot drift apart.
 */
export const JOB_STATE_LABELS: Readonly<Record<JobState, string>> = {
  QUEUED: 'Queued',
  UPLOADING: 'Uploading',
  ANALYZING: 'Analyzing video',
  TRANSCRIBING: 'Transcribing audio',
  FINDING_CLIPS: 'Finding viral moments',
  BUILDING_CLIPS: 'Building Shorts',
  RENDERING: 'Rendering 1080p',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

/**
 * Coarse progress floor for each state, so the UI can show a sensible bar
 * before a stage reports fine-grained progress of its own.
 */
export const JOB_STATE_PROGRESS: Readonly<Record<JobState, number>> = {
  QUEUED: 0,
  UPLOADING: 5,
  ANALYZING: 15,
  TRANSCRIBING: 30,
  FINDING_CLIPS: 55,
  BUILDING_CLIPS: 70,
  RENDERING: 85,
  COMPLETED: 100,
  FAILED: 100,
  CANCELLED: 100,
};
