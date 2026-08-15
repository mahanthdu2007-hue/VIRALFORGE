import { Wordmark } from '@/components/brand';
import { Studio } from '@/components/studio';
import { SystemBar } from '@/components/system-bar';
import { Badge } from '@/components/ui';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-8 px-5 py-8 sm:px-8 sm:py-12">
      <header className="flex flex-wrap items-center justify-between gap-5">
        <Wordmark />
        <SystemBar />
      </header>

      <section className="max-w-2xl space-y-4">
        <Badge tone="accent">Phase 1 · Foundation</Badge>
        <h1 className="text-balance text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl">
          <span className="text-gradient">Forge long-form video</span>
          <br />
          into Shorts worth watching.
        </h1>
        <p className="max-w-xl text-pretty text-sm leading-relaxed text-ink-muted sm:text-base">
          Upload a long video. ViralForge finds the moments that actually land, cuts coherent 30–40 second
          Shorts, reframes them to 9:16 and burns in synchronised subtitles — all from your original audio and
          footage.
        </p>
      </section>

      <Studio />

      <footer className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6 text-xs text-ink-faint">
        <span>ViralForge AI 2.0 — Phase 1 foundation. Analysis and rendering arrive in later phases.</span>
        <span className="font-mono">no synthetic voice · no rewritten dialogue</span>
      </footer>
    </main>
  );
}
