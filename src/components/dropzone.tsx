'use client';

/** File picker with drag-and-drop. Selection only — uploading lives in Studio. */

import { useCallback, useRef, useState } from 'react';
import { ACCEPTED_VIDEO_EXTENSIONS } from '@/validation/media-types';
import { formatBytes } from '@/lib/format';
import { cx } from './ui';

export function Dropzone({
  file,
  disabled,
  onSelect,
  onClear,
}: {
  file: File | null;
  disabled: boolean;
  onSelect: (file: File) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      if (disabled) return;
      const dropped = event.dataTransfer.files[0];
      if (dropped) onSelect(dropped);
    },
    [disabled, onSelect],
  );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={cx(
        'relative rounded-2xl border border-dashed p-8 text-center transition',
        dragging ? 'border-forge-400 bg-forge-500/10' : 'border-line bg-white/[0.02]',
        disabled && 'opacity-60',
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_VIDEO_EXTENSIONS.join(',')}
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          const picked = e.target.files?.[0];
          if (picked) onSelect(picked);
          e.target.value = '';
        }}
      />

      {file ? (
        <div className="flex flex-col items-center gap-3">
          <p className="max-w-full truncate text-sm font-medium">{file.name}</p>
          <p className="text-xs text-ink-faint">{formatBytes(file.size)}</p>
          <button
            type="button"
            onClick={onClear}
            disabled={disabled}
            className="text-xs font-medium text-ink-muted underline decoration-dotted underline-offset-4 hover:text-ink disabled:opacity-50"
          >
            Choose a different file
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <UploadGlyph />
          <div>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={disabled}
              className="text-sm font-semibold text-forge-400 hover:text-forge-500 disabled:opacity-50"
            >
              Select a video
            </button>
            <span className="text-sm text-ink-muted"> or drop it here</span>
          </div>
          <p className="text-xs text-ink-faint">
            {ACCEPTED_VIDEO_EXTENSIONS.map((e) => e.slice(1).toUpperCase()).join(' · ')}
          </p>
        </div>
      )}
    </div>
  );
}

function UploadGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="size-9 text-forge-400" aria-hidden>
      <path
        d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 15v2.5A2.5 2.5 0 0 0 6.5 20h11A2.5 2.5 0 0 0 20 17.5V15"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.55"
      />
    </svg>
  );
}
