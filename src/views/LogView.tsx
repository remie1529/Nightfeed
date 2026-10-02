import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface LogPayload {
  text: string;
  path: string;
  truncated: boolean;
  size: number;
}

export default function LogView({ onBack }: { onBack: () => void }) {
  const [raw, setRaw] = useState('');
  const [query, setQuery] = useState('');
  const [meta, setMeta] = useState<{ path: string; truncated: boolean; size: number } | null>(null);
  const [newestAtBottom, setNewestAtBottom] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const preRef = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);
  const queryRef = useRef('');

  const view = useMemo(() => {
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const ordered = newestAtBottom ? lines : [...lines].reverse();
    const q = query.trim().toLowerCase();
    const shown = q ? ordered.filter((line) => line.toLowerCase().includes(q)) : ordered;
    let body = '';
    if (!raw.trim()) body = '(empty — activity will appear here)';
    else if (!shown.length) body = '(no matching lines)';
    else body = `${shown.join('\n')}\n`;
    return { body, matched: q ? shown.length : null };
  }, [raw, query, newestAtBottom]);

  const applyPayload = useCallback((payload: LogPayload) => {
    setRaw(payload?.text || '');
    setMeta({
      path: payload.path || '',
      truncated: !!payload.truncated,
      size: payload.size || 0,
    });
  }, []);

  const refresh = useCallback(
    async (stick = true) => {
      if (stick) stickRef.current = true;
      setBusy(true);
      setError('');
      try {
        const payload = (await window.torrentAPI.getLogTail?.({ lines: 2000 })) as LogPayload;
        if (!payload) {
          const full = (await window.torrentAPI.getLog?.()) as LogPayload;
          applyPayload(full || { text: '', path: '', truncated: false, size: 0 });
        } else {
          applyPayload(payload);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [applyPayload]
  );

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  useEffect(() => {
    if (!autoRefresh) return;
    const off = window.torrentAPI.onLogChanged?.(() => {
      const searching = !!queryRef.current.trim();
      if (searching || (!stickRef.current && newestAtBottom)) {
        void refresh(false);
        return;
      }
      void refresh(true);
    });
    const timer = setInterval(() => {
      const searching = !!queryRef.current.trim();
      void refresh(!searching && stickRef.current);
    }, 4000);
    return () => {
      off?.();
      clearInterval(timer);
    };
  }, [autoRefresh, refresh, newestAtBottom]);

  useEffect(() => {
    if (query.trim()) return;
    const el = preRef.current;
    if (!el || !stickRef.current) return;
    requestAnimationFrame(() => {
      el.scrollTop = newestAtBottom ? el.scrollHeight : 0;
    });
  }, [view.body, newestAtBottom, query]);

  const onScroll = () => {
    const el = preRef.current;
    if (!el || query.trim()) return;
    if (newestAtBottom) {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    } else {
      stickRef.current = el.scrollTop < 48;
    }
  };

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(view.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const openFolder = async () => {
    try {
      const r = await window.torrentAPI.openLogFolder?.();
      if (r && r.ok === false && r.error) setError(r.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const sizeLabel =
    meta && meta.size > 0
      ? meta.size > 1024 * 1024
        ? `${(meta.size / (1024 * 1024)).toFixed(1)} MB`
        : `${Math.max(1, Math.round(meta.size / 1024))} KB`
      : '0 KB';

  return (
    <div className="page page-wide page-log">
      <div className="page-header">
        <div>
          <h1>Activity log</h1>
          <p>
            Timestamped app actions · kept about one week
            {meta?.truncated ? ' · showing recent portion' : ''} · {sizeLabel}
            {view.matched != null ? ` · ${view.matched} match${view.matched === 1 ? '' : 'es'}` : ''}
          </p>
        </div>
        <div className="toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
          <input
            className="log-search"
            type="search"
            placeholder="Search log"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search log"
          />
          <button type="button" onClick={onBack}>
            ← Settings
          </button>
          <button type="button" onClick={() => void refresh(true)} disabled={busy}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
          <button type="button" onClick={() => void copyAll()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" onClick={() => void openFolder()}>
            Open folder
          </button>
          <label className="log-toggle">
            <input
              type="checkbox"
              checked={newestAtBottom}
              onChange={(e) => {
                stickRef.current = true;
                setNewestAtBottom(e.target.checked);
              }}
            />
            Newest at bottom
          </label>
          <label className="log-toggle">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Live
          </label>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {meta?.path ? (
        <div className="hint log-path" title={meta.path}>
          {meta.path}
        </div>
      ) : null}

      <pre ref={preRef} className="log-pre" onScroll={onScroll}>
        {view.body || 'Loading…'}
      </pre>
    </div>
  );
}
