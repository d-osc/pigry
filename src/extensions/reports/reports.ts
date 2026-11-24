/** Reports that agents save in the workspace: .pigry/reports/<agent>/<name>.md (see reportLocation in the agent panel).
 * The Reports menu lists them per agent and shows them rendered. */
export const REPORTS_DIR = '.pigry/reports/';
const REPORT_EXTENSIONS = ['.md', '.markdown', '.txt'];

export interface ReportRef {
  /** Workspace-relative path. */
  path: string;
  /** The agent folder ('' for a file placed directly in .pigry/reports/). */
  owner: string;
  /** File name, with any sub-folders below the agent folder. */
  name: string;
}

export interface ReportGroup {
  owner: string;
  reports: ReportRef[];
}

/** Every report file in a file tree listing. */
export function reportsFromTree(entries: string[]): ReportRef[] {
  const reports: ReportRef[] = [];
  for (const entry of entries) {
    const path = entry.replace(/\\/g, '/');
    if (!path.startsWith(REPORTS_DIR)) continue;
    const lower = path.toLowerCase();
    if (!REPORT_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue;
    const parts = path.slice(REPORTS_DIR.length).split('/').filter(Boolean);
    if (parts.length === 0) continue;
    reports.push(parts.length === 1
      ? { path, owner: '', name: parts[0] }
      : { path, owner: parts[0], name: parts.slice(1).join('/') });
  }
  return reports;
}

/** Case-insensitive match on the agent folder, file name or path. */
export function filterReports(reports: ReportRef[], query: string): ReportRef[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return reports;
  return reports.filter((report) => report.path.toLowerCase().includes(needle));
}

/** Reports grouped by agent: agents A→Z, reports A→Z inside each. */
export function groupReports(reports: ReportRef[]): ReportGroup[] {
  const byOwner = new Map<string, ReportRef[]>();
  for (const report of reports) byOwner.set(report.owner, [...(byOwner.get(report.owner) ?? []), report]);
  return [...byOwner.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([owner, list]) => ({ owner, reports: [...list].sort((a, b) => a.name.localeCompare(b.name)) }));
}
