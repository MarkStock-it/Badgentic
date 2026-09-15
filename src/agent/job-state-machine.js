const ORDERED = [
  'DISCOVERED',
  'ANALYZING',
  'CAPABILITY_CHECK',
  'PLANNING',
  'GENERATING',
  'REFINING',
  'VALIDATING',
  'READY',
  'EXECUTING',
  'COMPLETED',
];

const SIDE_STATES = ['QUEUED', 'USER_ACTION_REQUIRED', 'UNSUPPORTED', 'FAILED', 'CANCELLED'];
const TERMINAL = new Set(['COMPLETED', 'UNSUPPORTED', 'FAILED', 'CANCELLED']);

// QUEUED is reachable from every non-terminal state: a failed run schedules
// attempt+1 by parking the job back in QUEUED (spec §5.4 retry layer 2).
const TRANSITIONS = {
  DISCOVERED: ['ANALYZING', 'UNSUPPORTED', 'QUEUED', 'FAILED', 'CANCELLED'],
  ANALYZING: ['CAPABILITY_CHECK', 'QUEUED', 'FAILED', 'CANCELLED'],
  CAPABILITY_CHECK: ['PLANNING', 'UNSUPPORTED', 'USER_ACTION_REQUIRED', 'QUEUED', 'FAILED', 'CANCELLED'],
  PLANNING: ['GENERATING', 'QUEUED', 'FAILED', 'CANCELLED'],
  GENERATING: ['REFINING', 'QUEUED', 'FAILED', 'CANCELLED'],
  REFINING: ['VALIDATING', 'READY', 'QUEUED', 'FAILED', 'CANCELLED'],
  VALIDATING: ['READY', 'QUEUED', 'FAILED', 'CANCELLED'],
  READY: ['EXECUTING', 'QUEUED', 'FAILED', 'CANCELLED'],
  EXECUTING: ['COMPLETED', 'USER_ACTION_REQUIRED', 'QUEUED', 'FAILED', 'CANCELLED'],
  USER_ACTION_REQUIRED: ['EXECUTING', 'CANCELLED', 'FAILED'],
  QUEUED: ['DISCOVERED', 'CANCELLED', 'FAILED'],
};

function isTerminal(state) {
  return TERMINAL.has(state);
}

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    const err = new Error(`Illegal job state transition: ${from} -> ${to}`);
    err.code = 'ILLEGAL_TRANSITION';
    throw err;
  }
  return true;
}

function isRetriable(state) {
  // After a run fails, a new run may only start from these states.
  return !TERMINAL.has(state) && state !== 'USER_ACTION_REQUIRED';
}

export const STATES = { ORDERED, SIDE_STATES };

export function createJobStateMachine() {
  return { ORDERED, SIDE_STATES, TRANSITIONS, isTerminal, canTransition, assertTransition, isRetriable };
}
