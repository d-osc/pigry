/** Path helpers for the Explorer's file tree: cut / copy / paste names, absolute paths, and telling files from folders.
 * Paths are repository-relative with "/" separators ("" is the repository root). */

export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export const parentDir = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export const joinPath = (folder: string, name: string): string => (folder ? `${folder}/${name}` : name);

/** Every file and folder path implied by a flat list of file paths. */
export function allPaths(entries: string[]): Set<string> {
  const paths = new Set<string>();
  for (const entry of entries) {
    const parts = entry.split('/');
    let prefix = '';
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      paths.add(prefix);
    }
  }
  return paths;
}

/** The tree only lists files, so a path is a folder when some file lives below it. */
export function isFolderPath(entries: string[], path: string): boolean {
  return entries.some((entry) => entry.startsWith(`${path}/`));
}

/** Where a pasted copy of `source` goes. Like VS Code: the same name when free, otherwise "name copy.ext", "name copy 2.ext"… */
export function uniquePastePath(source: string, targetFolder: string, exists: (path: string) => boolean): string {
  const name = baseName(source);
  const first = joinPath(targetFolder, name);
  if (!exists(first)) return first;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  let candidate = joinPath(targetFolder, `${stem} copy${extension}`);
  for (let n = 2; exists(candidate); n += 1) candidate = joinPath(targetFolder, `${stem} copy ${n}${extension}`);
  return candidate;
}

/** The repository root plus a relative path, written with the root's own separator (C:\work\app\src\a.ts or /work/app/src/a.ts). */
export function absolutePath(root: string, relative: string): string {
  if (!root) return relative;
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const base = root.replace(/[\\/]+$/, '');
  return relative ? `${base}${separator}${relative.split('/').join(separator)}` : base;
}
