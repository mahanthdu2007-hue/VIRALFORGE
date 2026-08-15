'use client';

/**
 * Results shelf.
 *
 * Three 9:16 slots, one per Short the run attempted. A slot with no render yet
 * (job still running, or fewer than 3 clips were selected) stays the plain
 * "awaiting render" placeholder from Phase 1; a rendered clip gets a real
 * preview and download, and a failed one shows why instead of pretending to
 * have a file.
 */

import { SHORT_MAX_DURATION_SEC, SHORT_MIN_DURATION_SEC } from '@/domain';
import { formatBytes, formatDuration } from '@/lib/format';
import { Badge } from './ui';

export interface RenderSummary {
  readonly id: string;
  readonly clipPlanId: string;
  readonly status: 'RENDERED' | 'FAILED';
  readonly durationSec: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly sizeBytes: number | null;
  readonly cueCount: number;
  readonly trackerId: string | null;
  readonly error: { kind: string; code: string; message: string } | null;
  readonly rank: number | null;
  readonly title: string | null;
  readonly downloadUrl: string | null;
}

const SLOT_COUNT = 3;

export function Results({ renders }: { renders: readonly RenderSummary[] | null }) {
  const slots: (RenderSummary | null)[] = Array.from(
    { length: SLOT_COUNT },
    (_, index) => renders?.[index] ?? null,
  );

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {slots.map((render, index) =>
        render ? (
          <ShortCard key={render.id} render={render} rank={render.rank ?? index + 1} />
        ) : (
          <EmptySlot key={`empty-${index}`} rank={index + 1} />
        ),
      )}
    </div>
  );
}

function EmptySlot({ rank }: { rank: number }) {
  return (
    <figure className="space-y-2.5">
      <div className="relative aspect-[9/16] overflow-hidden rounded-2xl border border-line bg-surface-2">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_35%,rgb(124_92_255/0.14),transparent_65%)]" />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
          <span className="font-mono text-2xl font-semibold text-ink-faint">#{rank}</span>
          <span className="text-[0.7rem] text-ink-faint">Awaiting render</span>
        </div>
        <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between">
          <Badge>1080 × 1920</Badge>
          <Badge>
            {SHORT_MIN_DURATION_SEC}–{SHORT_MAX_DURATION_SEC}s
          </Badge>
        </div>
      </div>
      <figcaption className="text-xs text-ink-faint">
        Short {rank} · preview and download arrive once rendering finishes
      </figcaption>
    </figure>
  );
}

function ShortCard({ render, rank }: { render: RenderSummary; rank: number }) {
  const failed = render.status === 'FAILED';

  return (
    <figure className="space-y-2.5">
      <div className="relative aspect-[9/16] overflow-hidden rounded-2xl border border-line bg-surface-2">
        {failed ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
            <span className="font-mono text-2xl font-semibold text-ember-500">#{rank}</span>
            <span className="text-[0.7rem] font-medium text-ember-500">Render failed</span>
            {render.error ? (
              <span className="text-[0.65rem] leading-relaxed text-ink-faint">{render.error.message}</span>
            ) : null}
          </div>
        ) : (
          <video
            className="absolute inset-0 h-full w-full object-cover"
            src={render.downloadUrl ?? undefined}
            controls
            preload="metadata"
            playsInline
          />
        )}

        <div className="pointer-events-none absolute bottom-3 left-3 right-3 flex items-center justify-between">
          <Badge tone={failed ? 'bad' : 'good'}>
            {failed ? 'Failed' : render.width && render.height ? `${render.width} × ${render.height}` : '9:16'}
          </Badge>
          <Badge>{render.durationSec !== null ? formatDuration(render.durationSec) : '—'}</Badge>
        </div>
      </div>

      <figcaption className="space-y-1.5">
        <p className="truncate text-sm font-medium text-ink">{render.title ?? `Short ${rank}`}</p>
        {!failed ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
            {render.sizeBytes !== null ? <span>{formatBytes(render.sizeBytes)}</span> : null}
            <span>
              {render.cueCount} caption cue{render.cueCount === 1 ? '' : 's'}
            </span>
            {render.trackerId ? <span>{render.trackerId} tracking</span> : null}
          </div>
        ) : null}
        {render.downloadUrl ? (
          <a
            href={render.downloadUrl}
            download
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-ink-muted transition hover:border-forge-500/40 hover:text-ink"
          >
            Download
          </a>
        ) : null}
      </figcaption>
    </figure>
  );
}
