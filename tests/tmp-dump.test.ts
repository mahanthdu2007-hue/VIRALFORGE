import { it } from 'vitest';
import { BENCHMARK_FIXTURES, runBenchmark } from '@/benchmark';

it('dump', async () => {
  const report = await runBenchmark(BENCHMARK_FIXTURES);
  const c = report.cases.find((c) => c.fixtureId === 'podcast-interview')!;
  console.log(JSON.stringify({ construction: c.construction, diversity: c.diversity }, null, 2));
});
