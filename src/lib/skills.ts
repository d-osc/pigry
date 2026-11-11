/** Skill metadata — id/name/description parsed from the markdown files in
 * .pigry/skills/. The id (file slug) is stable; the name and description
 * come from frontmatter or the body headings. */

import { getFileTree, readWorktreeFile } from './tauriClient';
import type { SkillEntry } from './mentions';

export const SKILLS_DIR = '.pigry/skills/';

/** Parses one skill markdown file into { id, name, description }.
 * Supported shapes: frontmatter (`name:` / `description:`) or a leading
 * `# Title` heading followed by a description paragraph. */
export function parseSkillMeta(id: string, markdown: string): SkillEntry {
  const lines = markdown.split('\n');

  // Frontmatter first — explicit beats inferred.
  let name = '';
  let description = '';
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length && lines[i].trim() !== '---'; i += 1) {
      const line = lines[i];
      const nameMatch = line.match(/^name:\s*(.+)$/);
      if (nameMatch) name = nameMatch[1].trim();
      const descMatch = line.match(/^description:\s*(.+)$/);
      if (descMatch) description = descMatch[1].trim();
    }
  }

  // Fallback: first `# ` heading is the name; the next paragraph is the
  // description.
  if (!name) {
    for (const line of lines) {
      const heading = line.match(/^#\s+(.+)$/);
      if (heading) {
        name = heading[1].trim();
        break;
      }
    }
  }
  if (!description) {
    let pastTitle = false;
    let collecting: string[] = [];
    for (const line of lines) {
      if (!pastTitle) {
        if (line.startsWith('# ')) pastTitle = true;
        continue;
      }
      const trimmed = line.trim();
      if (trimmed === '') {
        if (collecting.length > 0) break;
        continue;
      }
      if (trimmed.startsWith('#') || trimmed.startsWith('```')) break;
      collecting.push(trimmed);
      if (collecting.join(' ').length >= 160) break;
    }
    description = collecting.join(' ').slice(0, 200);
  }

  return { id, name: name || id, description };
}

/** Lists every skill with its parsed id/name/description. */
export async function listSkills(): Promise<SkillEntry[]> {
  const tree = await getFileTree();
  const paths = tree.entries.filter(
    (p) => p.startsWith(SKILLS_DIR) && p.endsWith('.md'),
  );
  const skills: SkillEntry[] = [];
  for (const path of paths) {
    const id = path.slice(SKILLS_DIR.length, -3);
    try {
      skills.push(parseSkillMeta(id, (await readWorktreeFile(path)).content));
    } catch {
      skills.push({ id, name: id, description: '' });
    }
  }
  return skills;
}
