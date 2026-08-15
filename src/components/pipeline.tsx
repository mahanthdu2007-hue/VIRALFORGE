'use client';

/**
 * Pipeline stage tracker.
 *
 * The stage list is derived from the domain job states, so it cannot drift from
 * what the backend actually reports. Stages beyond upload are marked `pending`
 * in Phase 1 — nothing here animates progress that is not really happening.
 */

import { JOB_STATE_LABELS, type JobState } from '@/domain';
import { cx, Dot, ProgressBar } from './ui';

/** Order the user experiences, which is the happy path through the machine. */
export const PIPELINE_STAGES = [
  'UPLOADING',
  'ANALYZING',
  'TRANSCRIBING',
  'FINDING_CLIPS',
  'BUILDING_CLIPS',
  'RENDERING',
] as const satisfies readonly JobState[];

export type StageStatus = 'done' | 'active' | 'pending' | 'failed';

/**
 * Map a live job state onto the stage list.
 *
 * `reached` is the job's *own* history of states, served by the status route —
 * not the states this client happened to observe. Polling samples; a stage that
 * begins and ends between two ticks is never seen, which is how a run that
 * transcribed, found clips and built them could show those three stages as
 * never having happened while the slow stages either side of them were ticked.
 *
 * Stages the job has been in are done, the current one is active, the rest stay
 * pending. A run that stops before rendering leaves that stage pending rather
 * than marked done for work nobody did.
 */
export function stageStatusesForJob(
  state: JobState,
  reached: readonly JobState[],
): Partial<Record<JobState, StageStatus>> {
  const statuses: Partial<Record<JobState, StageStatus>> = { UPLOADING: 'done' };

  for (const stage of PIPELINE_STAGES) {
    if (stage === 'UPLOADING') continue;
    if (stage === state) statuses[stage] = 'done';
    else if (reached.includes(stage)) statuses[stage] = 'done';
    else statuses[stage] = 'pending';
  }

  if (state === 'FAILED') {
    // The stage that was running when it failed is the one that failed.
    const lastReached = [...PIPELINE_STAGES].reverse().find((stage) => reached.includes(stage));
    if (lastReached) statuses[lastReached] = 'failed';
  } else if (!isTerminal(state) && (PIPELINE_STAGES as readonly JobState[]).includes(state)) {
    statuses[state] = 'active';
  }

  return statuses;
}

const isTerminal = (state: JobState): boolean =>
  state === 'COMPLETED' || state === 'FAILED' || state === 'CANCELLED';

const STAGE_DETAIL: Record<(typeof PIPELINE_STAGES)[number], string> = {
  UPLOADING: 'Stream the source file to local storage',
  ANALYZING: 'Read duration, resolution, FPS and audio track',
  TRANSCRIBING: 'Verbatim timed transcript from the original audio',
  FINDING_CLIPS: 'Score moments for hook, payoff and standalone clarity',
  BUILDING_CLIPS: 'Assemble coherent 30–40s Shorts with 9:16 framing',
  RENDERING: 'Burn subtitles and encode 1080×1920',
};

export function Pipeline({
  statuses,
  progress,
  note,
}: {
  statuses: Partial<Record<JobState, StageStatus>>;
  progress: number;
  note: string | null;
}) {
  return (
    <div className="space-y-4">
      <ProgressBar value={progress} />

      <ol className="space-y-1">
        {PIPELINE_STAGES.map((stage, index) => {
          const status = statuses[stage] ?? 'pending';
          return (
            <li
              key={stage}
              className={cx(
                'flex items-start gap-3 rounded-xl px-3 py-2.5 transition',
                status === 'active' && 'bg-forge-500/10',
                status === 'failed' && 'bg-ember-500/10',
              )}
            >
              <span className="mt-1.5 flex w-5 shrink-0 justify-center">
                {status === 'done' ? (
                  <CheckGlyph />
                ) : (
                  <Dot tone={status === 'active' ? 'accent' : status === 'failed' ? 'bad' : 'neutral'} />
                )}
              </span>

              <span className="min-w-0 flex-1">
                <span
                  className={cx(
                    'block text-sm font-medium',
                    status === 'pending' ? 'text-ink-faint' : 'text-ink',
                  )}
                >
                  {JOB_STATE_LABELS[stage]}
                </span>
                <span className="block text-xs text-ink-faint">{STAGE_DETAIL[stage]}</span>
              </span>

              <span className="mt-0.5 font-mono text-[0.7rem] text-ink-faint">
                {String(index + 1).padStart(2, '0')}
              </span>
            </li>
          );
        })}
      </ol>

      {note ? <p className="rounded-xl border border-line bg-white/[0.02] px-3.5 py-3 text-xs text-ink-muted">{note}</p> : null}
    </div>
  );
}

function CheckGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 text-signal-500" fill="none" aria-hidden>
      <path d="M3 8.5 6.2 11.5 13 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
