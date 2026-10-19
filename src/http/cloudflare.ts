/**
 * Cloudflare's edge addresses. With the site behind Cloudflare, every
 * connection comes from one of these, and the player's own address arrives in
 * CF-Connecting-IP. That header is believed only from these addresses: anyone
 * else could send it to dodge the per-IP limits.
 *
 * From https://www.cloudflare.com/ips-v4 and /ips-v6 (2026-10-20). They change
 * rarely; deploy/cloudflare-firewall.sh fetches the live list for the firewall,
 * and the Caddyfile's trusted_proxies repeats it.
 */
const RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

/** An address as a number and its width in bits, or null if unreadable. */
function parse(ip: string): { n: bigint; bits: number } | null {
  if (ip.includes('.')) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
    return { n: p.reduce((a, x) => (a << 8n) | BigInt(x), 0n), bits: 32 };
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return { n, bits: 128 };
}

const NETS = RANGES.map((r) => {
  const [addr, len] = r.split('/');
  const p = parse(addr!)!;
  const shift = BigInt(p.bits - Number(len));
  return { bits: p.bits, shift, prefix: p.n >> shift };
});

/** Whether a (normalized) address belongs to Cloudflare. */
export function isCloudflare(ip: string): boolean {
  const p = parse(ip);
  return Boolean(p && NETS.some((net) => net.bits === p.bits && p.n >> net.shift === net.prefix));
}
