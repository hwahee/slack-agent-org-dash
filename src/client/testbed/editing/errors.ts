import { ApiRequestError } from '../../api/http';

/** Validation issues from a 400 `VALIDATION_ERROR`, as `path: message` lines. */
export function issueLines(error: unknown): string[] {
  if (!(error instanceof ApiRequestError) || error.code !== 'VALIDATION_ERROR') return [];
  const details = error.details;
  if (!Array.isArray(details)) return [];
  return details.map(
    (issue: { path?: string; message?: string }) =>
      `${issue.path === undefined || issue.path === '' ? '(root)' : issue.path}: ${issue.message ?? ''}`,
  );
}

/** The sentence to show for a failed call. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
