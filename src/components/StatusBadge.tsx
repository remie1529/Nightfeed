import type { EpisodeStatus, MovieStatus } from '../lib/types';

const labels: Record<string, string> = {
  upcoming: 'Upcoming',
  aired: 'Aired',
  downloaded: 'Downloaded',
  downloading: 'Downloading',
  missing: 'Missing',
  ignored: 'Ignored',
};

export default function StatusBadge({ status }: { status: EpisodeStatus | MovieStatus }) {
  return <span className={`badge ${status}`}>{labels[status] || status}</span>;
}
