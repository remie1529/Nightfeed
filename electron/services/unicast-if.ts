/**
 * Windows: force a TCP socket out a specific adapter (IP_UNICAST_IF).
 * Binding localAddress is not enough — Windows still routes by destination
 * and will use Ethernet, so TAP-bound torrent sockets never reach seeders.
 */
let setsockoptFn:
  | ((s: number | bigint, level: number, optname: number, optval: Buffer, optlen: number) => number)
  | null
  | undefined;
let tcpConnectPatched = false;

const IPPROTO_IP = 0;
const IP_UNICAST_IF = 31;

function loadSetSockOpt(): NonNullable<typeof setsockoptFn> | null {
  if (setsockoptFn !== undefined) return setsockoptFn;
  if (process.platform !== 'win32') {
    setsockoptFn = null;
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi') as {
      load: (name: string) => { func: (sig: string) => (...a: unknown[]) => number };
    };
    const lib = koffi.load('ws2_32.dll');
    const fn = lib.func('int setsockopt(uintptr s, int level, int optname, const uint8_t *optval, int optlen)');
    setsockoptFn = fn as NonNullable<typeof setsockoptFn>;
    return setsockoptFn;
  } catch (err) {
    console.error('[unicast-if] koffi unavailable', err);
    setsockoptFn = null;
    return null;
  }
}

export function setHandleUnicastIf(handle: { fd?: number } | null | undefined, ifIndex: number): boolean {
  if (process.platform !== 'win32' || !ifIndex || !handle) return false;
  const fd = handle.fd;
  if (fd == null || fd === -1) return false;
  const fn = loadSetSockOpt();
  if (!fn) return false;
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(ifIndex >>> 0, 0);
  try {
    return fn(fd, IPPROTO_IP, IP_UNICAST_IF, buf, 4) === 0;
  } catch (err) {
    console.error('[unicast-if] setsockopt failed', err);
    return false;
  }
}

/** Patch libuv TCP.connect so IP_UNICAST_IF is set after bind, before ConnectEx. */
export function patchTcpConnectUnicastIf(getIfIndex: () => number | null): void {
  if (process.platform !== 'win32' || tcpConnectPatched) return;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const net = require('net') as typeof import('net');
  const probe = net.createServer();
  try {
    probe.listen(0, '127.0.0.1');
    const handle = (probe as unknown as { _handle?: { constructor?: { prototype?: any } } })._handle;
    const proto = handle?.constructor?.prototype;
    if (!proto || typeof proto.connect !== 'function') return;
    const orig = proto.connect;
    proto.connect = function patchedTcpConnect(...args: unknown[]) {
      const idx = getIfIndex();
      if (idx) setHandleUnicastIf(this, idx);
      return orig.apply(this, args);
    };
    tcpConnectPatched = true;
  } catch (err) {
    console.error('[unicast-if] TCP wrap patch failed', err);
  } finally {
    try {
      probe.close();
    } catch {
      // ignore
    }
  }
}
