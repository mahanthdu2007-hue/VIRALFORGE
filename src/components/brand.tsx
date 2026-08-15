/** ViralForge wordmark and glyph. Inline SVG so there is no asset to load. */

export function ForgeGlyph({ className = 'size-9' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" role="img" aria-label="ViralForge" className={className}>
      <defs>
        <linearGradient id="vf-glyph" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#9b82ff" />
          <stop offset="55%" stopColor="#7c5cff" />
          <stop offset="100%" stopColor="#2ee6c5" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#vf-glyph)" opacity="0.16" />
      <rect x="1" y="1" width="30" height="30" rx="9" fill="none" stroke="url(#vf-glyph)" strokeWidth="1.25" />
      {/* A play triangle narrowing into a spark — long-form forged into a Short. */}
      <path d="M12 8.5 22 16l-10 7.5V8.5Z" fill="url(#vf-glyph)" />
      <path d="M8.5 12.5v7" stroke="url(#vf-glyph)" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <div className="flex items-center gap-3">
      <ForgeGlyph />
      <div className="leading-none">
        <div className="text-[1.05rem] font-semibold tracking-tight">
          Viral<span className="text-forge-400">Forge</span>
          <span className="ml-1.5 align-super text-[0.6rem] font-medium tracking-widest text-ink-faint">AI</span>
        </div>
        <div className="mt-1 text-[0.7rem] text-ink-faint">Shorts, forged from your footage</div>
      </div>
    </div>
  );
}
