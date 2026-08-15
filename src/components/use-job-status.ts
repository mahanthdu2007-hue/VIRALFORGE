'use client';

/**
 * Polls a job until it reaches a terminal state.
 *
 * Polling rather than streaming: analysis takes minutes and a status payload is
 * a few hundred bytes, so an open connection per client would cost more than it
 * saves. Stops on its own once the job finishes.
 */

import { useEffect, useState } from 'react';
import type { JobState } from '@/domain';

const POLL_INTERVAL_MS = 1500;

export interface JobStatus {
  id: string;
  state: JobState;
  label: string;
  progress: number;
  terminal: boolean;
  failure: { kind: string; code: string; message: string } | null;
  /**
   * Every state the job has been in, from its own history. Polling misses
   * states — a stage can begin and end between two ticks, and a client that
   * mounts late never saw the earlier ones at all — so which stages are done is
   * read from here, not from what these poll responses happened to catch.
   */
  reached: JobState[];
}

export interface JobSummary {
  transcript: { available: boolean; segmentCount?: number; language?: string | null };
  candidates: { count: number };
  renders?: { count: number; url: string | null };
}

export function useJobStatus(jobId: string | null) {
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [summary, setSummary] = useState<JobSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) {
      setStatus(null);
      setSummary(null);
      setError(null);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}/status`);
        if (!res.ok) throw new Error(`Status check failed (${res.status})`);

        const next = (await res.json()) as JobStatus;
        if (cancelled) return;
        setStatus(next);

        if (next.terminal) {
          // One final read for what the run actually produced.
          const detail = await fetch(`/api/jobs/${jobId}`);
          if (detail.ok && !cancelled) setSummary((await detail.json()) as JobSummary);
          return;
        }

        timer = setTimeout(tick, POLL_INTERVAL_MS);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  return { status, summary, error };
}
