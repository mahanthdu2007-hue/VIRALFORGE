/**
 * The benchmark set.
 *
 * Five fixtures, one per kind of source material the product is aimed at. They
 * are written to be *representative*, not to be passed: each one carries at
 * least one moment the pipeline is expected to reject and at least one it is
 * expected to rank below something else. A change that makes every fixture look
 * better is as interesting as one that makes them look worse.
 *
 * Order is fixed, because the report is compared field by field against a
 * committed baseline.
 */

import type { BenchmarkFixture } from '../types';
import { podcastInterviewFixture } from './podcast-interview';
import { educationalExplainerFixture } from './educational-explainer';
import { storytellingFixture } from './storytelling';
import { opinionDebateFixture } from './opinion-debate';
import { fastConversationalFixture } from './fast-conversational';

export {
  podcastInterviewFixture,
  educationalExplainerFixture,
  storytellingFixture,
  opinionDebateFixture,
  fastConversationalFixture,
};

export const BENCHMARK_FIXTURES: readonly BenchmarkFixture[] = [
  podcastInterviewFixture,
  educationalExplainerFixture,
  storytellingFixture,
  opinionDebateFixture,
  fastConversationalFixture,
];
