/**
 * Small MCP server for a running Nightfeed. Localhost only.
 * Speaks Streamable HTTP: one JSON-RPC response per POST.
 */
const http = require('http');
const crypto = require('crypto');

const PROTOCOL = '2025-03-26';
const SUPPORTED = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

function json(res, status, body, extraHeaders) {
  const raw = body == null ? '' : JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(raw),
    'cache-control': 'no-store',
  }, extraHeaders || {}));
  res.end(raw);
}

function tokenOk(header, expected) {
  const value = String(header || '');
  const match = /^Bearer\s+(\S+)$/i.exec(value);
  const got = match ? match[1] : value.replace(/^Bearer\s+/i, '').trim();
  const a = Buffer.from(got);
  const b = Buffer.from(String(expected || ''));
  if (!b.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function toolSchema(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema || { type: 'object', properties: {} },
  };
}

async function dispatchMcp(message, tools) {
  if (!message || typeof message !== 'object') {
    return { error: { code: -32600, message: 'Invalid request' } };
  }
  const method = String(message.method || '');
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id') && message.id != null;
  if (method === 'initialize') {
    const requested = message.params && message.params.protocolVersion;
    return {
      result: {
        protocolVersion: SUPPORTED.has(requested) ? requested : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'nightfeed', version: '1' },
      },
    };
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return { notification: true };
  }
  if (method === 'ping') return { result: {} };
  if (method === 'tools/list') {
    return { result: { tools: (tools || []).map(toolSchema) } };
  }
  if (method === 'tools/call') {
    const params = message.params || {};
    const name = String(params.name || '');
    const tool = (tools || []).find((item) => item.name === name);
    if (!tool) {
      return { error: { code: -32602, message: `Unknown tool ${name}` } };
    }
    try {
      const data = await tool.run(params.arguments || {});
      const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      return {
        result: {
          content: [{ type: 'text', text: text.slice(0, 100000) }],
          isError: false,
        },
      };
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      return {
        result: {
          content: [{ type: 'text', text: text.slice(0, 4000) }],
          isError: true,
        },
      };
    }
  }
  if (!hasId) return { notification: true };
  return { error: { code: -32601, message: `Method not found: ${method}` } };
}

function rpcBody(message, outcome) {
  if (outcome.notification || !Object.prototype.hasOwnProperty.call(message, 'id')) return null;
  if (outcome.error) {
    return { jsonrpc: '2.0', id: message.id, error: outcome.error };
  }
  return { jsonrpc: '2.0', id: message.id, result: outcome.result };
}

function createMcpHttpServer(options) {
  const sessions = new Set();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/mcp') {
        json(res, 404, { error: 'MCP endpoint is /mcp' });
        return;
      }
      const expected = options.token();
      const header = req.headers.authorization || req.headers['x-nightfeed-token'] || '';
      if (!tokenOk(header, expected)) {
        json(res, 401, { error: 'Unauthorized' });
        return;
      }
      if (req.method === 'DELETE') {
        const sid = String(req.headers['mcp-session-id'] || '');
        if (sid) sessions.delete(sid);
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        res.write(': nightfeed\n\n');
        return;
      }
      if (req.method !== 'POST') {
        json(res, 405, { error: 'Use POST' });
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
      } catch {
        json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      const list = Array.isArray(payload) ? payload : [payload];
      const tools = options.tools();
      const replies = [];
      let newSession = '';
      for (const message of list) {
        const outcome = await dispatchMcp(message, tools);
        if (message && message.method === 'initialize') {
          newSession = crypto.randomBytes(16).toString('hex');
          sessions.add(newSession);
        }
        const body = rpcBody(message, outcome);
        if (body) replies.push(body);
      }
      if (!replies.length) {
        res.writeHead(202);
        res.end();
        return;
      }
      const headers = {};
      if (newSession) headers['mcp-session-id'] = newSession;
      json(res, 200, Array.isArray(payload) ? replies : replies[0], headers);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) json(res, 500, { error: message });
    }
  });

  return {
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const BRIDGE_SOURCE = `'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');

const cfgPath = path.join(__dirname, 'mcp.json');
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
} catch (err) {
  process.stderr.write('Nightfeed MCP config is missing. Turn MCP on in Nightfeed Settings.\\n');
  process.exit(1);
}

let session = '';

function post(message) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(message));
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer ' + cfg.token,
      'content-length': String(data.length),
    };
    if (session) headers['mcp-session-id'] = session;
    const req = http.request(cfg.url, { method: 'POST', headers }, (res) => {
      if (res.headers['mcp-session-id']) session = String(res.headers['mcp-session-id']);
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 401) {
          reject(new Error('Nightfeed rejected the MCP token. Copy a new config from Settings.'));
          return;
        }
        if (res.statusCode === 202 || !text.trim()) {
          resolve(null);
          return;
        }
        if ((res.headers['content-type'] || '').indexOf('text/event-stream') !== -1) {
          const lines = text.split(/\\n/).filter((line) => line.indexOf('data:') === 0);
          const last = lines.length ? lines[lines.length - 1].replace(/^data:\\s?/, '') : '';
          resolve(last ? JSON.parse(last) : null);
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', () => reject(new Error('Nightfeed is not running, or MCP is turned off.')));
    req.end(data);
  });
}

function writeMessage(message) {
  const raw = Buffer.from(JSON.stringify(message));
  process.stdout.write('Content-Length: ' + raw.length + '\\r\\n\\r\\n');
  process.stdout.write(raw);
}

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd === -1) return;
    const header = buffer.slice(0, headerEnd).toString('utf8');
    const match = /Content-Length:\\s*(\\d+)/i.exec(header);
    if (!match) {
      process.stderr.write('Bad MCP frame\\n');
      process.exit(1);
    }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const body = buffer.slice(start, start + length).toString('utf8');
    buffer = buffer.slice(start + length);
    let message;
    try {
      message = JSON.parse(body);
    } catch (err) {
      writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    post(message).then((reply) => {
      if (reply) writeMessage(reply);
    }).catch((err) => {
      const id = message && Object.prototype.hasOwnProperty.call(message, 'id') ? message.id : null;
      if (id != null) {
        writeMessage({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message || String(err) } });
      }
    });
  }
});
`;

module.exports = {
  dispatchMcp,
  createMcpHttpServer,
  BRIDGE_SOURCE,
};
