import { useQuery } from '@tanstack/react-query';
import type { NetbirdStatus } from '@mornihosting/shared';
import { api } from '@/lib/api';
import { useSession } from '@/features/auth/session';
import { dnsStatusQuery } from '@/features/dns/dns';

export const netbirdStatusQuery = {
  queryKey: ['netbird'],
  queryFn: () => api<NetbirdStatus>('/api/netbird'),
} as const;

/** Shared with the server, which names a server on its own when it goes on the domain. */
export { toNetbirdName } from '@mornihosting/shared';

/** The product's name for texts ({{brand}}, {{machine}}): MorniHosting, or the app that embeds it (MH_BRAND). */
export function brandOf(status: Pick<NetbirdStatus, 'brand' | 'machineHint'> | undefined): {
  brand?: string;
  machine?: string;
} {
  return status ? { brand: status.brand, machine: status.machineHint } : {};
}

/** Where server names become addresses: NetBird or the own domain (DNS), for admins only. */
export interface AddressAutomation {
  readonly domain: string;
  readonly via: 'netbird' | 'dns';
}

/** The address automation this user may use: set up and an admin, otherwise null. */
export function useAddressAutomation(): AddressAutomation | null {
  const { me } = useSession();
  const enabled = me.user.isAdmin;
  const { data: netbird } = useQuery({ ...netbirdStatusQuery, enabled });
  const { data: dns } = useQuery({ ...dnsStatusQuery, enabled });
  if (!enabled) return null;
  if (netbird?.configured && netbird.domain) return { domain: netbird.domain, via: 'netbird' };
  return dns?.configured && dns.domain ? { domain: dns.domain, via: 'dns' } : null;
}
