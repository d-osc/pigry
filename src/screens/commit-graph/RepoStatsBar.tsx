/** Repository stats bar for the commit graph screen. */
import { useEffect, useState } from 'react';
import { Users, FileCode2, GitCommitHorizontal } from 'lucide-react';
import { getRepoStats } from '../../lib/tauriClient';
import type { RepoStats } from '../../types/repository';
import './RepoStatsBar.css';

export function RepoStatsBar() {
  const [stats, setStats] = useState<RepoStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    getRepoStats()
      .then((result) => {
        if (!cancelled) setStats(result);
      })
      .catch(() => {
        if (!cancelled) setStats(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!stats) return null;

  const topLanguages = stats.languages.slice(0, 5);

  return (
    <div className="repo-stats">
      <span className="repo-stats__item">
        <GitCommitHorizontal size={11} />
        {stats.totalCommits} commits
      </span>
      <span className="repo-stats__item">
        <Users size={11} />
        {stats.contributors.length} contributor{stats.contributors.length === 1 ? '' : 's'}
      </span>
      <span className="repo-stats__languages">
        {topLanguages.map((lang) => (
          <span key={lang.language} className="repo-stats__lang" title={`${lang.files} files`}>
            <FileCode2 size={10} />
            {lang.language}
          </span>
        ))}
      </span>
    </div>
  );
}
