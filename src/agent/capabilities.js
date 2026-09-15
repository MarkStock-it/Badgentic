import { PERMISSIONS } from './agent-permissions.js';

/**
 * Capability registry (v1): three capabilities ship; anything else the
 * capability analyzer recognizes goes to UNSUPPORTED (spec §5.1, §9 risk 3).
 */
export const CAPABILITIES = {
  assignment_document: {
    kind: 'assignment_document',
    generateTemplate: 'generate/assignment_document',
    artifact: { ext: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    write: 'SUBMISSION',
    requiredPermissions: [PERMISSIONS.CANVAS_SUBMISSION, PERMISSIONS.CANVAS_FILE_UPLOAD],
    acceptedSubmissionTypes: ['online_upload'],
  },
  discussion_post: {
    kind: 'discussion_post',
    generateTemplate: 'generate/discussion_post',
    artifact: { ext: 'md', mimeType: 'text/markdown' },
    write: 'COMMENT',
    requiredPermissions: [PERMISSIONS.CANVAS_COMMENT],
    acceptedSubmissionTypes: null, // comment flow works on any assignment
  },
  study_deck: {
    kind: 'study_deck',
    generateTemplate: 'generate/study_deck',
    artifact: { ext: 'md', mimeType: 'text/markdown' },
    write: null, // no Canvas write
    requiredPermissions: [],
    acceptedSubmissionTypes: null,
  },
};

export function getCapability(kind) {
  return CAPABILITIES[kind] || null;
}

/** Pre-check (spec §9 risk 6): does the assignment accept this output? */
export function assignmentSupportsCapability(assignment, capability) {
  if (!capability.acceptedSubmissionTypes) return { ok: true };
  const types = assignment?.submission_types || [];
  const ok = capability.acceptedSubmissionTypes.some((t) => types.includes(t));
  return {
    ok,
    reason: ok ? null : `Assignment accepts [${types.join(', ') || 'none'}] — ${capability.kind} requires ${capability.acceptedSubmissionTypes.join(', ')}`,
  };
}

export function missingPermissions(capability, permissions) {
  return capability.requiredPermissions.filter((p) => !permissions?.[p]);
}
