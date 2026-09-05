export function formatBytes(n: number): string {
  if (!n || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatSpeed(n: number): string {
  if (!n) return '0 B/s';
  return `${formatBytes(n)}/s`;
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function epCode(season: number, episode: number): string {
  return `S${pad2(season)}E${pad2(episode)}`;
}

export function formatPercent(p: number): string {
  return `${Math.round((p || 0) * 100)}%`;
}
