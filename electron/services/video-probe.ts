import { execFile } from 'child_process';
import path from 'path';
import type { Resolution } from '../types';
import { detectResolution } from './search';

export function resolutionFromHeight(height: number): Resolution | null {
  if (height >= 1600) return '2160p';
  if (height >= 900) return '1080p';
  if (height >= 650) return '720p';
  return null;
}

export async function probeVideoFile(
  filePath: string
): Promise<{ width: number; height: number; resolution: Resolution | null }> {
  const probed = await ffprobeSize(filePath);
  if (probed && probed.height > 0) {
    return {
      width: probed.width,
      height: probed.height,
      resolution: resolutionFromHeight(probed.height),
    };
  }
  return {
    width: 0,
    height: 0,
    resolution: detectResolution(path.basename(filePath)),
  };
}

function ffprobeSize(filePath: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-of',
        'json',
        filePath,
      ],
      { timeout: 20000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(null);
          return;
        }
        try {
          const data = JSON.parse(String(stdout)) as {
            streams?: Array<{ width?: number; height?: number }>;
          };
          const s = data.streams?.[0];
          const width = Number(s?.width) || 0;
          const height = Number(s?.height) || 0;
          resolve(height > 0 ? { width, height } : null);
        } catch {
          resolve(null);
        }
      }
    );
  });
}
