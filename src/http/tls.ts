import { existsSync, statSync } from 'node:fs';

/**
 * HTTPS for the direct game port. Players connect straight to this process
 * (wss://<domain>:DIRECT_PORT) instead of through Caddy, so each frame is
 * encrypted once, in uWS's C++, rather than proxied and encrypted again.
 *
 * The certificates are Caddy's — it obtains and renews them for the website —
 * copied into TLS_CERT_DIR as <domain>.crt / <domain>.key by
 * deploy/sync-certs.sh, since Caddy keeps them readable by root alone.
 *
 * Several site names can share the port: players connect to the one their
 * page is on, and the TLS handshake (SNI) picks its certificate.
 */
export interface TlsConfig {
  dir: string;
  /**
   * The names players connect to directly; the first is the default. A page
   * on www.<domain> still connects to <domain>:DIRECT_PORT.
   */
  domains: string[];
}

export const certFiles = (dir: string, domain: string) => ({
  key_file_name: `${dir}/${domain}.key`,
  cert_file_name: `${dir}/${domain}.crt`,
});

export const present = (dir: string, domain: string) =>
  existsSync(`${dir}/${domain}.crt`) && existsSync(`${dir}/${domain}.key`);

const mtime = (dir: string, domain: string) => {
  try {
    return statSync(`${dir}/${domain}.crt`).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * On a brand-new server Caddy has not fetched a certificate yet, and an HTTPS
 * server cannot start without one: wait for it rather than crash-looping.
 */
export async function waitForCerts(tls: TlsConfig): Promise<void> {
  const first = tls.domains[0]!;
  if (present(tls.dir, first)) return;
  console.log(`[tls] waiting for a certificate for ${first} in ${tls.dir} (deploy/sync-certs.sh copies it from Caddy)`);
  while (!present(tls.dir, first)) await new Promise((r) => setTimeout(r, 5000));
  console.log(`[tls] certificate for ${first} found`);
}

/** How often to look for a renewed certificate. Renewals come every ~60 days. */
const CHECK_MS = 60_000;
/**
 * A renewed certificate arrives weeks before the old one expires, so the
 * restart that loads it can wait for a moment with nobody connected — but
 * not forever.
 */
const MAX_WAIT_MS = 7 * 24 * 3600_000;

/**
 * A name added to the server has no certificate until its DNS points here and
 * Caddy fetches one; nobody can reach it before then, so loading it sooner
 * is worth a restart while people play.
 */
const MAX_WAIT_NEW_MS = 30 * 60_000;

/**
 * Watches for Caddy's renewed certificates, and for the first certificate of
 * a name that had none at startup. uWS cannot swap the certificate of a
 * running server in place, so a new one is loaded by a restart: `restart` is
 * called once nobody is connected, or after the wait above regardless. Rooms
 * survive it the way they survive a deploy.
 */
export function watchRenewal(
  tls: TlsConfig,
  isIdle: () => boolean,
  restart: (reason: string) => void,
): void {
  const started = new Map(tls.domains.map((d) => [d, mtime(tls.dir, d)]));
  let changedAt = 0;
  let maxWait = MAX_WAIT_MS;
  setInterval(() => {
    if (!changedAt) {
      for (const [domain, was] of started) {
        const m = mtime(tls.dir, domain);
        // Wait for the copy to settle: the key and certificate land one by one.
        if (m === was || Date.now() - m < 5000) continue;
        changedAt = Date.now();
        if (!was) maxWait = MAX_WAIT_NEW_MS;
        console.log(`[tls] ${was ? 'renewed' : 'new'} certificate for ${domain}; restarting to load it once nobody is connected`);
        break;
      }
      if (!changedAt) return;
    }
    if (isIdle() || Date.now() - changedAt > maxWait) {
      restart('certificate changed');
    }
  }, CHECK_MS).unref();
}
