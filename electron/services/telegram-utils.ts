/**
 * Pure Telegram helpers (no Electron dependency) for token redaction,
 * HTML escaping, and strict chat-ID parsing.
 */
export function escapeHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function redactTelegramToken(text: string, token: string): string {
  const raw = String(text || '');
  const t = String(token || '').trim();
  if (!t) return raw;
  return raw.split(t).join('[redacted]');
}

/** Normalize unicode dashes/minus and strip junk; keep signed numeric chat ids only. */
export function normalizeChatIdToken(raw: string): string | null {
  if (raw == null) return null;
  // Unicode minus/dashes → ASCII hyphen-minus; drop zero-width / BOM junk
  const s = String(raw)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u2212\u2010-\u2015\uFE58\uFE63\uFF0D]/g, '-')
    .trim();
  if (!s) return null;
  return /^-?\d+$/.test(s) ? s : null;
}

export function parseChatIds(raw: string): Set<string> {
  const out = new Set<string>();
  for (const token of (raw || '').split(/[\s,;]+/)) {
    const id = normalizeChatIdToken(token);
    if (id) out.add(id);
  }
  return out;
}
