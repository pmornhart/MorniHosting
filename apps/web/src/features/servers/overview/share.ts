import { useQuery } from '@tanstack/react-query';
import { PORT_BEDROCK, SOFTWARE, type ConnectionInfo, type ServerDetail } from '@mornihosting/shared';
import { api } from '@/lib/api';

const PORT_SEPARATOR = ':';

export function withPort(host: string, port: number, defaultPort: number): string {
  return port === defaultPort ? host : `${host}${PORT_SEPARATOR}${port}`;
}

export interface ShareInfo {
  readonly data: ConnectionInfo;
  /** What friends type in: the name (with SRV) or host:port. */
  readonly shareAddress: string | null;
  readonly host: string | null;
  readonly sharePort: number;
  /** Bedrock players' host and UDP port when Geyser is on (NetBird may give them their own name). */
  readonly bedrockHost: string | null;
  readonly bedrockPort: number | null;
}

/** The address of a server as the panel shows it everywhere (head, address card). */
export function useShareInfo(server: ServerDetail): ShareInfo | null {
  const { data } = useQuery({
    queryKey: ['connection', server.id],
    queryFn: () => api<ConnectionInfo>(`/api/servers/${server.id}/connection`),
  });
  if (!data) return null;
  const defaultPort = SOFTWARE[server.software].defaultPort;
  const host = data.domain ?? data.publicIp ?? data.lanIp;
  // With a domain friends use the tunnel's port (NetBird, playit.gg) if one is set; via the IP the server port.
  const sharePort = data.domain ? data.sharePort : data.port;
  // A SRV record at the own domain tells Java where the port is; Bedrock has its own port field.
  const routed = server.netbird?.routed;
  const bareName =
    data.srv === true || routed?.java === true || (server.edition === 'bedrock' && data.domain !== null);
  const shareAddress = host && bareName ? host : host && withPort(host, sharePort, defaultPort);
  const bedrock = server.netbird?.services.find((s) => s.purpose === 'geyser');
  // Through the address router Bedrock players use the same name as Java and the usual port 19132.
  if (routed?.bedrock && host) {
    return { data, shareAddress, host, sharePort, bedrockHost: host, bedrockPort: PORT_BEDROCK };
  }
  return {
    data,
    shareAddress,
    host,
    sharePort,
    bedrockHost: bedrock?.domain ?? host,
    bedrockPort: bedrock?.port ?? server.geyserPort,
  };
}
