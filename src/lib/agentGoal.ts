const GOAL_STATUS = /^goal status:\s*(continue|complete|blocked)[.!]?$/i;

export function goalStatus(text: string): 'continue' | 'complete' | 'blocked' {
  const lines = text.trim().split(/\r?\n/);
  const lastLine = lines[lines.length - 1]?.replace(/[*_`]/g, '').trim() ?? '';
  const status = GOAL_STATUS.exec(lastLine)?.[1]?.toLowerCase();
  return status === 'complete' || status === 'blocked' ? status : 'continue';
}
