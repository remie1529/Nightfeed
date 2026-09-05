import type { EpisodeStatus } from '../lib/types';

const labels: Record<EpisodeStatus, string> = {
  upcoming: 'Upcoming',
  aired: 'Aired',
  downloaded: 'Downloaded',
  downloading: 'Downloading',
  missing: 'Missing',
  ignored: 'Ignored',
};

export default function StatusBadge({ status }: { status: EpisodeStatus }) {
  return <span className={`badge ${status}`}>{labels[status] || status}</span>;
}
