/**
 * Scoring weights.
 *
 * Isolated in their own module because they are the part of scoring most likely
 * to change, and changing them must never mean touching the measurement code.
 * Component weights sum to 1, so a clip that maxes everything and is penalised
 * for nothing scores exactly 1.
 *
 * The numbers encode a product opinion — a strong hook and standing alone matter
 * more than hitting 35 seconds exactly — not a measured relationship to
 * anything. They are a ranking device for one video's own moments.
 */

import { CLIP_SCORE_COMPONENTS, type ClipScoreWeights } from '@/domain';

export const DEFAULT_SCORE_WEIGHTS: ClipScoreWeights = {
  components: {
    hook: 0.17,
    curiosity: 0.08,
    emotion: 0.1,
    information: 0.11,
    standalone: 0.12,
    payoff: 0.1,
    // Whether the clip is one whole thought is worth as much as any single
    // trait it displays: a strong line inside a fragment is still a fragment.
    structure: 0.09,
    momentum: 0.07,
    opening: 0.06,
    ending: 0.06,
    duration: 0.04,
  },
  penalties: {
    filler: 0.1,
    repetition: 0.08,
    contextDependency: 0.12,
    boilerplate: 0.1,
  },
};

/** Sum of the component weights. Exported so a test can pin the invariant. */
export const totalComponentWeight = (weights: ClipScoreWeights): number =>
  CLIP_SCORE_COMPONENTS.reduce((total, key) => total + weights.components[key], 0);
