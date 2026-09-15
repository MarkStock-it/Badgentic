/**
 * Permissions (spec §5.3): ported model. Defaults match BetterCLSS —
 * comment ON, file upload and submission OFF. Every Canvas write must ALSO
 * pass the approval gate; permissions are necessary, not sufficient.
 */
export const PERMISSIONS = {
  CANVAS_COMMENT: 'canvas_comment',
  CANVAS_FILE_UPLOAD: 'canvas_file_upload',
  CANVAS_SUBMISSION: 'canvas_submission',
};

export const DEFAULT_PERMISSIONS = {
  [PERMISSIONS.CANVAS_COMMENT]: true,
  [PERMISSIONS.CANVAS_FILE_UPLOAD]: false,
  [PERMISSIONS.CANVAS_SUBMISSION]: false,
};

export function resolvePermissions({ defaults = DEFAULT_PERMISSIONS, userOverrides = {} } = {}) {
  return { ...defaults, ...userOverrides };
}

export function isAllowed(permissions, permission) {
  return Boolean(permissions?.[permission]);
}
