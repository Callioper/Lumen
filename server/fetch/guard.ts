import { isIP } from 'node:net';
import { lookup, type LookupAddress } from 'node:dns';
import { promisify } from 'node:util';
import { Agent } from 'undici';

// Fetches made on behalf of feed content (images, icons, full text) must not reach
// this machine or the LAN: a hostile feed or web page could otherwise aim them at
// local services (the RSSHub bridge, router admin pages, ...).

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

const v4ToInt = (ip: string): number => ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);

function inV4Range(ip: string, base: string, bits: number): boolean {
  const size = 2 ** (32 - bits);
  return Math.floor(v4ToInt(ip) / size) === Math.floor(v4ToInt(base) / size);
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return V4_BLOCKED.some(([base, bits]) => inV4Range(ip, base, bits));
  const h = ip.toLowerCase();
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  // unspecified, loopback, unique-local fc00::/7, link-local fe80::/10, site-local fec0::/10, multicast
  return h === '::' || h === '::1' || /^(fc|fd|fe[89a-f]|ff)/.test(h);
}

// URL parsing already normalises decimal/octal/hex IPv4 forms, so a literal check suffices here.
export function isPrivateHostname(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  return isIP(h) ? isPrivateAddress(h) : false;
}

export class BlockedAddressError extends Error {
  code = 'EPRIVATE';
}

const lookupAll = promisify(lookup);

// Checked before each hop; requests through the proxy are resolved by the proxy, so this is
// their only check. Direct requests are checked again at connect time by guardedAgent.
export async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockedAddressError(`不支持的协议 ${url.protocol}`);
  if (isPrivateHostname(url.hostname)) throw new BlockedAddressError(`拒绝访问内网地址 ${url.hostname}`);
  if (isIP(url.hostname.replace(/^\[|\]$/g, ''))) return;
  const addrs = (await lookupAll(url.hostname, { all: true })) as LookupAddress[];
  const bad = addrs.find((a) => isPrivateAddress(a.address));
  if (bad) throw new BlockedAddressError(`${url.hostname} 解析到内网地址 ${bad.address}`);
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

// Re-validates the address actually connected to, which closes the DNS-rebinding gap
// between assertPublicUrl's lookup and the connection.
export const guardedAgent = new Agent({
  connections: 16,
  connect: {
    lookup(hostname: string, options: { all?: boolean }, callback: LookupCallback): void {
      lookup(hostname, { ...options, all: true }, (err, addrs) => {
        if (err) return callback(err, []);
        const bad = addrs.find((a) => isPrivateAddress(a.address));
        if (bad) return callback(new BlockedAddressError(`拒绝连接内网地址 ${bad.address}`), []);
        if (options.all) return callback(null, addrs);
        return callback(null, addrs[0].address, addrs[0].family);
      });
    },
  } as never,
});
