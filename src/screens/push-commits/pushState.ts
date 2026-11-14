export type SortDirection = 'asc' | 'desc';

export function parsePushSort(raw: string | null): SortDirection {
  // Older versions stored a JSON string instead of the plain preference.
  return raw === 'asc' || raw === '"asc"' ? 'asc' : 'desc';
}

export function canPushPreview(upstream: string | null, ahead: number): boolean {
  return upstream === null || ahead > 0;
}

export function pushErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || 'Unable to load push preview.';
  if (typeof error === 'string' && error.trim()) return error;
  return 'Unable to load push preview. Check the repository and try again.';
}
