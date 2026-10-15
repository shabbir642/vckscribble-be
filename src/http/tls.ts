import { existsSync, statSync } from 'node:fs';

/**
 * HTTPS for the direct game port. Players connect straight to this process
 * (wss://<domain>:DIRECT_PORT) instead of through Caddy, so each frame is
 * encrypted once, in uWS's C++, rather than proxied and encrypted again.
 *
 * The certificates are Caddy's — it obtains and renews them for the website —
 * copied into TLS_CERT_DIR as <domain>.crt / <domain>.key by
 * deploy/sync-certs.sh, since Caddy keeps them readable by root alone.
 */
export interface TlsConfig {
  dir: string;
  /**
   * The name players connect to directly (one certificate, so one name: a page
   * on www.<domain> still connects to <domain>:DIRECT_PORT).
   */
  domains: string[];
}

export const certFiles = (dir: string, domain: string) => ({
  key_file_name: `${dir}/${domain}.key`,
  cert_file_name: `${dir}/${domain}.crt`,
});

const present = (dir: string, domain: string) =>
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
 * Watches for Caddy's renewed certificate. uWS cannot swap the certificate of
 * a running server in place (a per-name certificate gets its own, empty set of
 * routes), so the new one is loaded by a restart: `restart` is called once
 * nobody is connected, or after MAX_WAIT_MS regardless. Rooms survive it the
 * way they survive a deploy.
 */
export function watchRenewal(
  tls: TlsConfig,
  isIdle: () => boolean,
  restart: (reason: string) => void,
): void {
  const domain = tls.domains[0]!;
  const started = mtime(tls.dir, domain);
  let renewedAt = 0;
  setInterval(() => {
    if (!renewedAt) {
      const m = mtime(tls.dir, domain);
      // Wait for the copy to settle: the key and certificate land one by one.
      if (m === started || Date.now() - m < 5000) return;
      renewedAt = Date.now();
      console.log(`[tls] renewed certificate for ${domain}; restarting to load it once nobody is connected`);
    }
    if (isIdle() || Date.now() - renewedAt > MAX_WAIT_MS) {
      restart('certificate renewed');
    }
  }, CHECK_MS).unref();
}
