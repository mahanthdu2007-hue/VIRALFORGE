'use client';

/**
 * Studio — the interactive shell.
 *
 * Owns the client-side flow: pick a file, stream it to `POST /api/videos`, show
 * the metadata FFmpeg actually reported, then request analysis. Analysis returns
 * 501 in Phase 1 and the UI says so plainly instead of pretending to work.
 *
 * The upload uses XHR rather than fetch purely to get real progress events; the
 * File is streamed by the browser, never read into JS memory.
 */

import { useCallback, useEffect, useState } from 'react';
import type { JobState, MediaMetadata, VideoAsset } from '@/domain';
import { formatBytes, formatDuration } from '@/lib/format';
import { Dropzone } from './dropzone';
import { Pipeline, stageStatusesForJob, type StageStatus } from './pipeline';
import { useJobStatus, type JobStatus, type JobSummary } from './use-job-status';
import { Results, type RenderSummary } from './results';
import { Badge, GhostButton, Panel, PrimaryButton, SectionHeading } from './ui';

type Phase = 'idle' | 'uploading' | 'importing' | 'ready' | 'requesting' | 'running' | 'error';

interface ApiError {
  error: { kind: string; code: string; message: string; details?: Record<string, unknown> };
}

export function Studio() {
  const [file, setFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [uploadPercent, setUploadPercent] = useState(0);
  const [video, setVideo] = useState<VideoAsset | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [renders, setRenders] = useState<RenderSummary[] | null>(null);

  const { status, summary, error: statusError } = useJobStatus(jobId);
  const running = phase === 'running' && !status?.terminal;
  const busy = phase === 'uploading' || phase === 'importing' || phase === 'requesting' || running;

  // Once the job reaches a terminal state, fetch whatever the render stage
  // actually produced — zero, some, or all three, successes and failures alike.
  // Asked for by job: a video analysed twice has two runs' worth of renders on
  // record, and the earlier run's clips are not this run's results.
  useEffect(() => {
    if (!video || !jobId || !status?.terminal) {
      setRenders(null);
      return;
    }

    let cancelled = false;
    fetch(`/api/videos/${video.id}/renders?jobId=${jobId}`)
      .then((res) => (res.ok ? res.json() : { renders: [] }))
      .then((body: { renders?: RenderSummary[] }) => {
        if (!cancelled) setRenders(body.renders ?? []);
      })
      .catch(() => {
        if (!cancelled) setRenders([]);
      });

    return () => {
      cancelled = true;
    };
  }, [video, jobId, status?.terminal]);

  const reset = useCallback(() => {
    setFile(null);
    setVideo(null);
    setPhase('idle');
    setUploadPercent(0);
    setMessage(null);
    setJobId(null);
    setRenders(null);
  }, []);

  const upload = useCallback(async (selected: File) => {
    setPhase('uploading');
    setUploadPercent(0);
    setMessage(null);

    try {
      const asset = await uploadVideo(selected, setUploadPercent);
      setVideo(asset);
      setPhase('ready');
      setUploadPercent(100);
    } catch (error) {
      setPhase('error');
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  /**
   * Import from a link instead of a file.
   *
   * Deliberately lands in the same state the upload path does — a `VideoAsset`
   * and `phase: 'ready'` — so everything downstream, including Analyse, cannot
   * tell how the video arrived.
   */
  const importUrl = useCallback(async () => {
    const url = sourceUrl.trim();
    if (url.length === 0) return;

    setFile(null);
    setVideo(null);
    setPhase('importing');
    setMessage(null);

    try {
      const res = await fetch('/api/videos/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const body = (await res.json()) as ApiError & { video?: VideoAsset };

      if (res.status === 201 && body.video) {
        setVideo(body.video);
        setPhase('ready');
        setUploadPercent(100);
        setSourceUrl('');
        return;
      }

      setPhase('error');
      setMessage(body.error?.message ?? `Unexpected response (${res.status}).`);
    } catch (error) {
      setPhase('error');
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [sourceUrl]);

  const requestAnalysis = useCallback(async () => {
    if (!video) return;
    setPhase('requesting');
    setMessage(null);

    try {
      const res = await fetch('/api/analysis', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoId: video.id, clipCount: 3 }),
      });
      const body = (await res.json()) as ApiError & { job?: { id: string } };

      if (res.status === 202 && body.job) {
        setJobId(body.job.id);
        setPhase('running');
        return;
      }

      setPhase('error');
      setMessage(body.error?.message ?? `Unexpected response (${res.status}).`);
    } catch (error) {
      setPhase('error');
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [video]);

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      {/* ---------------------------------------------------------------- */}
      <Panel className="space-y-6 p-6">
        <SectionHeading
          eyebrow="Step 01"
          title="Source video"
          aside={video ? <Badge tone="good">Uploaded</Badge> : null}
        />

        <Dropzone
          file={file}
          disabled={busy}
          onSelect={(selected) => {
            setFile(selected);
            setVideo(null);
            setMessage(null);
            void upload(selected);
          }}
          onClear={reset}
        />

        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-white/10" />
            <span className="text-[11px] uppercase tracking-wider text-white/40">or paste a link</span>
            <span className="h-px flex-1 bg-white/10" />
          </div>

          <div className="flex gap-2">
            <input
              type="url"
              inputMode="url"
              value={sourceUrl}
              disabled={busy}
              placeholder="https://www.youtube.com/watch?v=…"
              onChange={(event) => setSourceUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void importUrl();
                }
              }}
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white/90 outline-none placeholder:text-white/30 focus:border-white/25 disabled:opacity-50"
              aria-label="YouTube link"
            />
            <PrimaryButton onClick={() => void importUrl()} disabled={busy || sourceUrl.trim().length === 0}>
              {phase === 'importing' ? 'Downloading…' : 'Import'}
            </PrimaryButton>
          </div>

          {phase === 'importing' ? (
            <p className="text-xs text-white/50">
              Downloading from YouTube. A long video takes a few minutes.
            </p>
          ) : null}
        </div>

        {video?.metadata ? <MetadataGrid metadata={video.metadata} sizeBytes={video.sizeBytes} /> : null}

        <div className="flex flex-wrap items-center gap-3">
          <PrimaryButton onClick={requestAnalysis} disabled={!video || busy}>
            {phase === 'requesting' ? 'Starting…' : running ? status?.label ?? 'Working…' : 'Find viral moments'}
          </PrimaryButton>
          <GhostButton onClick={reset} disabled={busy || phase === 'idle'}>
            Reset
          </GhostButton>
        </div>

        {message ? (
          <p
            className={
              phase === 'error'
                ? 'rounded-xl border border-ember-500/30 bg-ember-500/10 px-4 py-3 text-sm text-ember-500'
                : 'rounded-xl border border-forge-500/25 bg-forge-500/10 px-4 py-3 text-sm text-ink-muted'
            }
            role="status"
          >
            {message}
          </p>
        ) : null}

        <p className="text-xs leading-relaxed text-ink-faint">
          ViralForge never generates a synthetic voice and never rewrites what the speaker said. Every Short uses
          your original audio and footage; the AI only decides what to keep and how to frame it.
        </p>
      </Panel>

      {/* ---------------------------------------------------------------- */}
      <div className="space-y-5">
        <Panel className="space-y-5 p-6">
          <SectionHeading
            eyebrow="Step 02"
            title="Processing"
            aside={
              status ? (
                <Badge tone={status.state === 'FAILED' ? 'bad' : status.terminal ? 'good' : 'accent'}>
                  {status.label}
                </Badge>
              ) : null
            }
          />
          <Pipeline
            statuses={status ? stageStatusesForJob(status.state, status.reached) : stageStatuses(phase)}
            progress={status ? status.progress : overallProgress(phase, uploadPercent)}
            note={pipelineNote(status, summary, statusError)}
          />
        </Panel>

        <Panel className="space-y-5 p-6">
          <SectionHeading
            eyebrow="Step 03"
            title="Your Shorts"
            aside={<Badge>{renders ? renders.filter((r) => r.status === 'RENDERED').length : 0} of 3</Badge>}
          />
          <Results renders={renders} />
        </Panel>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function MetadataGrid({ metadata, sizeBytes }: { metadata: MediaMetadata; sizeBytes: number }) {
  const facts: [string, string][] = [
    ['Duration', formatDuration(metadata.durationSec)],
    ['Resolution', `${metadata.width} × ${metadata.height}`],
    ['Frame rate', `${metadata.fps} fps`],
    ['Audio', metadata.hasAudio ? (metadata.audioCodec ?? 'present') : 'none'],
    ['Video codec', metadata.videoCodec ?? 'unknown'],
    ['Size', formatBytes(sizeBytes)],
  ];

  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-3">
      {facts.map(([label, value]) => (
        <div key={label} className="bg-surface-2 px-4 py-3">
          <dt className="text-[0.65rem] uppercase tracking-[0.14em] text-ink-faint">{label}</dt>
          <dd className="mt-1 truncate font-mono text-sm text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const stageStatuses = (phase: Phase): Partial<Record<JobState, StageStatus>> => {
  if (phase === 'uploading') return { UPLOADING: 'active' };
  if (phase === 'error') return { UPLOADING: 'failed' };
  if (phase === 'ready' || phase === 'requesting') return { UPLOADING: 'done' };
  return {};
};

const overallProgress = (phase: Phase, uploadPercent: number): number => {
  if (phase === 'uploading') return Math.round(uploadPercent * 0.15);
  if (phase === 'ready' || phase === 'requesting') return 15;
  return 0;
};

/** One honest line about where the run got to. */
function pipelineNote(
  status: JobStatus | null,
  summary: JobSummary | null,
  statusError: string | null,
): string | null {
  if (statusError) return statusError;
  if (!status) return null;

  if (status.state === 'FAILED') {
    return status.failure ? `Failed: ${status.failure.message}` : 'The analysis failed.';
  }

  if (status.terminal && summary) {
    const segments = summary.transcript.segmentCount ?? 0;
    const renderCount = summary.renders?.count ?? 0;
    const renderNote =
      renderCount > 0 ? ` ${renderCount} Short${renderCount === 1 ? '' : 's'} rendered.` : '';
    return `Transcript stored (${segments} segments) and ${summary.candidates.count} candidate moment(s) found.${renderNote}`;
  }

  return null;
}

/** Streams `file` to the API, reporting 0–100 upload progress. */
function uploadVideo(file: File, onProgress: (percent: number) => void): Promise<VideoAsset> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/videos');
    // Percent-encoded: HTTP headers are latin-1 only, filenames are not.
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };

    xhr.onload = () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(xhr.responseText);
      } catch {
        reject(new Error(`Upload failed with status ${xhr.status}.`));
        return;
      }

      if (xhr.status === 201) {
        resolve((parsed as { video: VideoAsset }).video);
      } else {
        reject(new Error((parsed as ApiError).error?.message ?? `Upload failed (${xhr.status}).`));
      }
    };

    xhr.onerror = () => reject(new Error('Network error during upload.'));
    xhr.send(file);
  });
}
