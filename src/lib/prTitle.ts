/** The title GitHub proposes for a new pull request: the commit message when there is exactly one commit, otherwise the
 * branch name turned into words ("feat/command-menu" → "Feat/command menu"). */
export function suggestPrTitle(branch: string, commitSummaries: string[]): string {
  if (commitSummaries.length === 1 && commitSummaries[0].trim()) return commitSummaries[0].trim();
  const words = branch.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}
