'use client';

/**
 * Environment readiness strip.
 *
 * Reports what the machine actually has — FFmpeg version, active AI provider —
 * rather than assuming. If FFmpeg is missing the user needs to know before they
 * pick a file.
 */

import { useEffect, useState } from 'react';
import { Badge, Dot } from './ui';

interface SystemInfo {
  phase: number;
  config: { env: string; aiProvider: string; maxUploadMb: number };
  ffmpeg: { available: boolean; ffmpegVersion: string | null; ffprobeVersion: string | null };
  ai: { active: { displayName: string; ok: boolean; detail: string } };
}

export function SystemBar() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/system')
      .then(async (res) => {
        if (!res.ok) throw new Error(`System check failed (${res.status})`);
        return (await res.json()) as SystemInfo;
      })
      .then((data) => !cancelled && setInfo(data))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <Badge tone="bad">
        <Dot tone="bad" /> {error}
      </Badge>
    );
  }

  if (!info) {
    return (
      <Badge>
        <Dot tone="neutral" /> Checking environment…
      </Badge>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone={info.ffmpeg.available ? 'good' : 'bad'}>
        <Dot tone={info.ffmpeg.available ? 'good' : 'bad'} />
        {info.ffmpeg.available ? `FFmpeg ${info.ffmpeg.ffmpegVersion ?? 'ready'}` : 'FFmpeg not found'}
      </Badge>
      <Badge tone={info.ai.active.ok ? 'accent' : 'warn'}>
        <Dot tone={info.ai.active.ok ? 'accent' : 'warn'} />
        {info.ai.active.displayName}
      </Badge>
      <Badge>Phase {info.phase}</Badge>
      <Badge>Max {info.config.maxUploadMb} MB</Badge>
    </div>
  );
}
