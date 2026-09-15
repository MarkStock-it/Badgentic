/**
 * In-process counters (spec §7.5): jobs by state, AI calls, Canvas errors.
 * Good enough for a single instance; phase-2 worker would aggregate in DB.
 */
export function createMetrics() {
  const counters = new Map();

  function incr(name, by = 1) {
    counters.set(name, (counters.get(name) || 0) + by);
  }

  return {
    incr,
    snapshot() {
      return {
        ...Object.fromEntries(counters),
        jobsByState: Object.fromEntries([...counters.entries()].filter(([k]) => k.startsWith('job.state.'))),
        uptimeSeconds: Math.round(process.uptime()),
      };
    },
  };
}
