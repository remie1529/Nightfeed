/**
 * Pure poster URL sizer (zero Node/Electron imports — safe in sandboxed preload & tests).
 *
 * IMDb GraphQL / suggest URLs (`m.media-amazon.com/images/M/..._V1_.jpg`) point to raw
 * 2000–6000px theatrical print posters (3–15 MB each), which load slowly and alias badly
 * when Chromium downscales them 25x into a 140px card. Rewriting the Amazon Media
 * transform suffix delivers ~35–75 KB crisp 2x Retina posters directly from the CDN.
 */
export type PosterSizeTier = 'thumb' | 'w342' | 'w500';

const AMAZON_IMAGE_HOST_RE = /^https?:\/\/(?:m\.media-amazon\.com|ia\.media-imdb\.com)\/images\//i;
const AMAZON_V1_SUFFIX_RE = /\._V1_[^/]*\.(jpg|jpeg|png|webp)(?:\?.*)?$/i;

const AMAZON_TRANSFORM: Record<PosterSizeTier, string> = {
  thumb: 'QL80_UX140',
  w342: 'QL82_UX360',
  w500: 'QL85_UX560',
};

export function normalizePosterTier(size?: string): PosterSizeTier {
  if (size === 'thumb' || size === 'w500' || size === 'w342') return size;
  return 'w342';
}

export function sizePosterUrl(rawUrl: string | null | undefined, size?: string): string | null {
  const url = String(rawUrl || '').trim();
  if (!url) return null;
  if (!AMAZON_IMAGE_HOST_RE.test(url)) return url;
  const tier = normalizePosterTier(size);
  const transform = AMAZON_TRANSFORM[tier];
  if (AMAZON_V1_SUFFIX_RE.test(url)) {
    return url.replace(AMAZON_V1_SUFFIX_RE, `._V1_${transform}_.$1`);
  }
  return url;
}
