import { describe, it, expect } from 'vitest';
import { createJobStateMachine } from '../src/agent/job-state-machine.js';

const sm = createJobStateMachine();

describe('job state machine', () => {
  it('allows the happy path in order', () => {
    const path = ['DISCOVERED', 'ANALYZING', 'CAPABILITY_CHECK', 'PLANNING', 'GENERATING', 'REFINING', 'VALIDATING', 'READY', 'EXECUTING', 'COMPLETED'];
    for (let i = 0; i < path.length - 1; i++) {
      expect(sm.canTransition(path[i], path[i + 1]), `${path[i]} -> ${path[i + 1]}`).toBe(true);
    }
  });

  it('rejects skipping the pipeline', () => {
    expect(sm.canTransition('DISCOVERED', 'COMPLETED')).toBe(false);
    expect(sm.canTransition('ANALYZING', 'EXECUTING')).toBe(false);
    expect(sm.canTransition('GENERATING', 'READY')).toBe(false);
  });

  it('terminal states have no outgoing transitions', () => {
    for (const t of ['COMPLETED', 'UNSUPPORTED', 'FAILED', 'CANCELLED']) {
      expect(sm.isTerminal(t)).toBe(true);
      expect(sm.canTransition(t, 'ANALYZING')).toBe(false);
    }
  });

  it('allows cancellation from pipeline states and QUEUED', () => {
    for (const s of ['QUEUED', 'DISCOVERED', 'ANALYZING', 'GENERATING', 'READY', 'EXECUTING']) {
      expect(sm.canTransition(s, 'CANCELLED'), `${s} -> CANCELLED`).toBe(true);
    }
  });

  it('rejects illegal transitions with assertTransition', () => {
    expect(() => sm.assertTransition('COMPLETED', 'ANALYZING')).toThrow(/Illegal job state transition/);
    expect(sm.assertTransition('QUEUED', 'DISCOVERED')).toBe(true);
  });

  it('flags retriable states', () => {
    expect(sm.isRetriable('QUEUED')).toBe(true);
    expect(sm.isRetriable('FAILED')).toBe(false);
    expect(sm.isRetriable('USER_ACTION_REQUIRED')).toBe(false);
  });
});
