import dns from 'node:dns';

/**
 * The addresses of a few named hosts (e.g. "moinmorni" in the same Docker network), looked up now and again every
 * minute – a container gets a new address when it is recreated. IP addresses are taken as they are.
 */
const REFRESH_MS = 60_000;
const IPV4_MAPPED = '::ffff:';

export interface TrustedHosts {
  readonly has: (address: string | undefined) => boolean;
}

export function trustedHosts(names: readonly string[]): TrustedHosts {
  const known = new Set<string>();
  const refresh = async (): Promise<void> => {
    const found = await Promise.all(
      names.map(async (name) => {
        try {
          return (await dns.promises.lookup(name, { all: true })).map((a) => a.address);
        } catch {
          return [];
        }
      }),
    );
    known.clear();
    found.flat().forEach((a) => known.add(a));
  };
  if (names.length > 0) {
    void refresh();
    setInterval(() => void refresh(), REFRESH_MS).unref();
  }
  return {
    has: (address) => {
      if (typeof address !== 'string') return false;
      return known.has(address.startsWith(IPV4_MAPPED) ? address.slice(IPV4_MAPPED.length) : address);
    },
  };
}
