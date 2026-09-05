/// <reference types="vite/client" />

import type { TorrentAPI } from '../electron/preload';

declare global {
  interface Window {
    torrentAPI: TorrentAPI;
  }
}

export {};
