import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { createNightfeedTools, type NightfeedMcpApi } from '../electron/services/mcp-tools';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createMcpHttpServer } = require('../electron/services/mcp-protocol.js');

const TOKEN = '0123456789abcdef0123456789abcdef';

test('MCP server closes promptly with open SSE stream and handles null/undefined/oversized payloads', async () => {
  const server = createMcpHttpServer({
    token: () => TOKEN,
    tools: () => [
      {
        name: 'returns_undefined',
        description: 'Returns undefined',
        inputSchema: { type: 'object', properties: {} },
        run: () => undefined,
      },
    ],
  });

  const port = await server.listen(0);
  try {
    // 1. POST with null body returns JSON-RPC -32600 (not HTTP 500 TypeError)
    const nullRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: 'null',
    });
    assert.equal(nullRes.status, 200);
    const nullJson = (await nullRes.json()) as { error?: { code?: number } };
    assert.equal(nullJson.error?.code, -32600);

    // 2. Tool returning undefined succeeds with empty text (not isError: true)
    const undefRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'returns_undefined', arguments: {} },
      }),
    });
    assert.equal(undefRes.status, 200);
    const undefJson = (await undefRes.json()) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> };
    };
    assert.equal(undefJson.result?.isError, false);
    assert.equal(undefJson.result?.content?.[0]?.text, '');

    // 3. Open SSE connection must NOT deadlock server.close()
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${port}/mcp`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
        (res) => {
          res.once('data', () => resolve());
          res.on('error', () => undefined);
        }
      );
      req.on('error', () => undefined);
      setTimeout(() => reject(new Error('SSE open timeout')), 2000);
    });

    const t0 = Date.now();
    await server.close();
    assert.ok(Date.now() - t0 < 2000, 'server.close() hung with open SSE stream');
  } finally {
    await server.close().catch(() => undefined);
  }
});

test('MCP tools validate numeric args and magnet links strictly', async () => {
  const api = {
    getShow: () => ({}),
    downloadMovie: async () => ({}),
  } as unknown as NightfeedMcpApi;
  const tools = createNightfeedTools(api);
  const getShow = tools.find((t) => t.name === 'nightfeed_get_show')!;
  const dlMovie = tools.find((t) => t.name === 'nightfeed_download_movie')!;

  assert.throws(() => getShow.run({ mazeId: null }), /must be a number/i);
  assert.throws(() => getShow.run({ mazeId: '' }), /must be a number/i);
  assert.throws(() => getShow.run({ mazeId: false }), /must be a number/i);
  assert.throws(() => getShow.run({ mazeId: [] }), /must be a number/i);
  assert.throws(
    () => dlMovie.run({ id: 133093, magnet: 'http://example.com/file.torrent' }),
    /must start with magnet:/i
  );
});
