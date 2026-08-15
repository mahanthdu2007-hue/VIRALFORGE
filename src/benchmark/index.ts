/**
 * Clip-quality benchmark.
 *
 * A repeatable, offline measurement of what the clip stage does to
 * representative material: which moments it accepts, which it spends its build
 * budget on, what it scores them, and which three it ships. Import from
 * `@/benchmark`, not deep paths.
 *
 * It calls production code and nothing else, so it is a *measurement* rather
 * than a second opinion — see `harness.ts`. Nothing here is imported by the app,
 * the API or the render pipeline.
 */

export * from './types';
export * from './transcript';
export * from './harness';
export { BENCHMARK_FIXTURES } from './fixtures';
