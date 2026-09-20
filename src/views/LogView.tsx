import { useCallback, useEffect, useRef, useState } from 'react';

interface LogPayload {
  text: string;
  path: string;
  truncated: boolean;
  size: number;
}

export default function LogView({ onBack }: { onBack: () => void }) {
  const [text, setText] = useState('');
  const [meta, setMeta] = useState<{ path: string; truncated: boolean; size: number } | null>(null);
  const [newestAtBottom, setNewestAtBottom] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const preRef = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);

  const applyPayload = useCallback(
    (payload: LogPayload, stick: boolean) => {
      const raw = payload?.text || '';
      const lines = raw.replace(/\r\n/g, '\n').split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      const display = newestAtBottom ? lines.join('\n') : [...lines].reverse().join('\n');
      setText(display ? `${display}\n` : '(empty — activity will appear here)');
      setMeta({
        path: payload.path || '',
        truncated: !!payload.truncated,
        size: payload.size || 0,
      });
      if (stick && newestAtBottom) {
        requestAnimationFrame(() => {
          const el = preRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      } else if (stick && !newestAtBottom) {
        requestAnimationFrame(() => {
          const el = preRef.current;
          if (el) el.scrollTop = 0;
        });
      }
    },
    [newestAtBottom]
  );

  const refresh = useCallback(
    async (stick = true) => {
      setBusy(true);
      setError('');
      try {
        const payload = (await window.torrentAPI.getLogTail?.({ lines: 2000 })) as LogPayload;
        if (!payload) {
          const full = (await window.torrentAPI.getLog?.()) as LogPayload;
          applyPayload(full || { text: '', path: '', truncated: false, size: 0 }, stick);
        } else {
          applyPayload(payload, stick);
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
    if (!autoRefresh) return;
    const off = window.torrentAPI.onLogChanged?.(() => {
      if (!stickRef.current && newestAtBottom) {
        void refresh(false);
        return;
      }
      void refresh(true);
    });
    const timer = setInterval(() => void refresh(stickRef.current), 4000);
    return () => {
      off?.();
      clearInterval(timer);
    };
  }, [autoRefresh, refresh, newestAtBottom]);

  useEffect(() => {
    void refresh(true);
    // re-order when toggle flips
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newestAtBottom]);

  const onScroll = () => {
    const el = preRef.current;
    if (!el) return;
    if (newestAtBottom) {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    } else {
      stickRef.current = el.scrollTop < 48;
    }
  };

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(text);
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
          </p>
        </div>
        <div className="toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
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
              onChange={(e) => setNewestAtBottom(e.target.checked)}
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
        {text || 'Loading…'}
      </pre>
    </div>
  );
}
