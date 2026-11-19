// File name of the e2e results JSON (no dependencies, no side effects).
// The full run is "results-all.json"; a short selection keeps its step names;
// a long one gets a short hash — the step names joined with "+" exceeded the
// Windows path limit (MAX_PATH) once the runner had ~30 steps.
import { createHash } from 'node:crypto';

const MAX_NAMED = 40;

export function resultsFileName(steps, allSteps) {
  const all = steps.length === allSteps.length && steps.every((s, i) => s === allSteps[i]);
  if (all) return 'results-all.json';
  const joined = steps.join('+');
  if (joined.length <= MAX_NAMED) return `results-${joined}.json`;
  return `results-${steps.length}-steps-${createHash('sha256').update(joined).digest('hex').slice(0, 10)}.json`;
}
