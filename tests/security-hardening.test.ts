import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  WebPortalServer,
  hashWebPortalPassword,
  sanitizePortalUrl,
  verifyWebPortalPasswordAsync,
} from '../electron/services/web-portal';
import { extractZipSafely } from '../electron/services/safe-unzip';
import {
  normalizeChatIdToken,
  redactTelegramToken,
} from '../electron/services/telegram-utils';
import { DEFAULT_SETTINGS, type AppSettings, type TelegramRequest } from '../electron/types';

test('WebPortalServer enforces async login, ephemeral session secret, CSRF, rate limiting, CSP, and request isolation', async () => {
  const passwordHash = hashWebPortalPassword('super-secret-pass');
  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    webPortalEnabled: true,
    webPortalPort: 0,
    webPortalBind: 'localhost',
    webPortalAdminPasswordHash: passwordHash,
    // Intentionally blank to test ephemeral session secret persistence
    webPortalSessionSecret: '',
  };

  const requests: TelegramRequest[] = [
    {
      id: 'req-tg-1',
      mediaType: 'movie',
      mediaId: 133093,
      title: 'The Matrix',
      requesterChatId: 999,
      status: 'pending',
      createdAt: new Date().toISOString(),
      source: 'telegram',
    },
  ];
  const resolvedCalls: Array<{ id: string; action: string }> = [];

  const portal = new WebPortalServer();
  portal.setDeps({
    getSettings: () => settings,
    searchShows: async () => [],
    searchMovies: async () => [],
    isInLibrary: () => false,
    submitRequest: async (input) => {
      const created: TelegramRequest = {
        id: `req-web-${requests.length + 1}`,
        mediaType: input.mediaType,
        mediaId: input.mediaId,
        title: input.title,
        year: input.year,
        overview: input.overview,
        posterUrl: input.posterUrl,
        requesterChatId: 0,
        requesterClientId: input.requesterClientId,
        status: 'pending',
        createdAt: new Date().toISOString(),
        source: 'web',
      };
      requests.push(created);
      return { ok: true, message: 'Submitted', request: created };
    },
    listRequests: () => requests,
    resolveRequest: async (id, action) => {
      resolvedCalls.push({ id, action });
      return { ok: true, message: 'ok' };
    },
  });

  await portal.start(settings);
  const port = portal.getBoundPort();
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. Async password check
    assert.equal(await verifyWebPortalPasswordAsync('super-secret-pass', passwordHash), true);
    assert.equal(await verifyWebPortalPasswordAsync('wrong-pass', passwordHash), false);

    // 2. Security headers on HTML page
    const homeRes = await fetch(`${base}/`);
    assert.equal(homeRes.status, 200);
    assert.equal(homeRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(homeRes.headers.get('x-frame-options'), 'DENY');
    assert.ok((homeRes.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'"));

    // 3. Invalid JSON returns 400 and does NOT poison lastError
    const badJsonRes = await fetch(`${base}/api/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-valid-json',
    });
    assert.equal(badJsonRes.status, 400);
    assert.equal(portal.getStatus(settings).lastError, null);

    // 4. POST /api/request strips non-http posterUrl (javascript:)
    const submitRes = await fetch(`${base}/api/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mediaType: 'movie',
        mediaId: 1375666,
        title: 'Inception',
        posterUrl: 'javascript:alert(1)',
        requesterClientId: 'client-abc-123456',
      }),
    });
    assert.equal(submitRes.status, 200);
    const submitData = (await submitRes.json()) as { ok: boolean; request?: TelegramRequest };
    assert.equal(submitData.ok, true);
    assert.equal(submitData.request?.posterUrl, null);
    assert.equal(sanitizePortalUrl('https://example.com/p.jpg'), 'https://example.com/p.jpg');
    assert.equal(sanitizePortalUrl('javascript:alert(1)'), null);

    // 5. GET /api/request/:id blocks unauthenticated access to Telegram/other requests
    const tgReqRes = await fetch(`${base}/api/request/req-tg-1`);
    assert.equal(tgReqRes.status, 403);
    const ownReqRes = await fetch(
      `${base}/api/request/${submitData.request!.id}?clientId=client-abc-123456`
    );
    assert.equal(ownReqRes.status, 200);

    // 6. Login succeeds with blank webPortalSessionSecret (ephemeral secret persists)
    const loginRes = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=super-secret-pass',
      redirect: 'manual',
    });
    assert.equal(loginRes.status, 303);
    const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie.startsWith('nf_admin='));

    // 7. Authenticated /admin renders dashboard (not login page) with CSRF token
    const adminRes = await fetch(`${base}/admin`, { headers: { Cookie: cookie } });
    const adminHtml = await adminRes.text();
    assert.ok(adminHtml.includes('/admin/approve'), 'Expected admin dashboard HTML');
    const csrfMatch = adminHtml.match(/name="csrf"\s+value="([^"]+)"/);
    assert.ok(csrfMatch && csrfMatch[1], 'Expected CSRF token in admin form');
    const csrfToken = csrfMatch[1];

    // 8. POST /admin/approve WITHOUT CSRF token is rejected with 403
    const noCsrfRes = await fetch(`${base}/admin/approve`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'id=req-tg-1',
      redirect: 'manual',
    });
    assert.equal(noCsrfRes.status, 403);
    assert.equal(resolvedCalls.length, 0);

    // 9. POST /admin/approve WITH valid CSRF token succeeds (303)
    const okCsrfRes = await fetch(`${base}/admin/approve`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `id=req-tg-1&csrf=${encodeURIComponent(csrfToken)}`,
      redirect: 'manual',
    });
    assert.equal(okCsrfRes.status, 303);
    assert.equal(resolvedCalls.length, 1);
    assert.deepEqual(resolvedCalls[0], { id: 'req-tg-1', action: 'approved' });

    // 10. Brute-force rate limit kicks in after 10 attempts (we already used 1 above -> 9 more, 11th is 429)
    let got429 = false;
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`${base}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'password=wrong',
      });
      if (r.status === 429) {
        got429 = true;
        assert.ok(r.headers.get('retry-after'));
        break;
      }
    }
    assert.equal(got429, true, 'Expected HTTP 429 rate limit on /admin/login');
  } finally {
    await portal.stopAsync();
  }
});

test('extractZipSafely handles quotes/unicode apostrophes in path and blocks Zip-Slip', async () => {
  if (process.platform !== 'win32') return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-zip-sec-'));
  try {
    // 1. Safe zip with apostrophe + Unicode right single quote in filename
    const goodZip = path.join(tmp, "test's\u2019addon.zip");
    const goodOut = path.join(tmp, 'out-good');
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $z = [System.IO.Compression.ZipFile]::Open($env:Z_PATH, 'Create')
        try {
          $e = $z.CreateEntry('addon.json')
          $w = New-Object System.IO.StreamWriter($e.Open())
          $w.Write('{"id":"ok"}')
          $w.Dispose()
        } finally { $z.Dispose() }
        `,
      ],
      { windowsHide: true, env: { ...process.env, Z_PATH: goodZip } }
    );
    await extractZipSafely(goodZip, goodOut);
    assert.equal(fs.readFileSync(path.join(goodOut, 'addon.json'), 'utf8'), '{"id":"ok"}');

    // 2. Malicious Zip-Slip archive with ../evil.txt entry
    const evilZip = path.join(tmp, 'evil.zip');
    const evilOut = path.join(tmp, 'nested', 'out-evil');
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $z = [System.IO.Compression.ZipFile]::Open($env:Z_PATH, 'Create')
        try {
          $e = $z.CreateEntry('../escaped.txt')
          $w = New-Object System.IO.StreamWriter($e.Open())
          $w.Write('pwned')
          $w.Dispose()
        } finally { $z.Dispose() }
        `,
      ],
      { windowsHide: true, env: { ...process.env, Z_PATH: evilZip } }
    );
    await assert.rejects(() => extractZipSafely(evilZip, evilOut), /escapes destination/i);
    assert.equal(fs.existsSync(path.join(tmp, 'nested', 'escaped.txt')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Telegram chat id parsing is strict and token redaction scrubs all occurrences', () => {
  assert.equal(normalizeChatIdToken('123456789'), '123456789');
  assert.equal(normalizeChatIdToken('-100123456789'), '-100123456789');
  assert.equal(normalizeChatIdToken('\u2212100999'), '-100999');
  assert.equal(normalizeChatIdToken('12345-6789'), null);
  assert.equal(normalizeChatIdToken('user123'), null);
  assert.equal(normalizeChatIdToken('123abc'), null);

  const secret = '123456:ABC-DEF-SECRET';
  const scrubbed = redactTelegramToken(
    `Failed https://api.telegram.org/bot${secret}/sendMessage (${secret})`,
    secret
  );
  assert.equal(scrubbed.includes(secret), false);
  assert.equal(scrubbed, 'Failed https://api.telegram.org/bot[redacted]/sendMessage ([redacted])');
});
