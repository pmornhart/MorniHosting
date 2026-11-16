import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Save, Trash2, TriangleAlert } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  clientPort,
  PORT_BEDROCK,
  type NetbirdPurpose,
  type NetbirdServerInfo,
  type NetbirdServiceInfo,
  type ServerDetail,
} from '@mornihosting/shared';
import { CopyButton } from '@/components/copy-button';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/label';
import { Pill } from '@/components/ui/pill';
import { api } from '@/lib/api';
import { errorText } from '@/lib/query';
import { NetbirdNameInput } from './NetbirdNameInput';
import { brandOf, netbirdStatusQuery } from './netbird';

const ORDER: readonly NetbirdPurpose[] = ['main', 'geyser', 'voice'];
/** The TCP half of Geyser has the same address as the UDP half: not listed on its own. */
const HIDDEN: readonly NetbirdPurpose[] = ['geyser-signal'];

/**
 * What players type for one service. On the domain itself that is the domain (the port decides where they land),
 * without the port games use anyway; otherwise the service's own name and port.
 */
function playerAddress(service: NetbirdServiceInfo, server: ServerDetail, domain: string): string {
  if (!server.netbird?.onDomain) return service.port ? `${service.domain}:${service.port}` : service.domain;
  const usual = service.purpose === 'main' ? clientPort(server.software) : PORT_BEDROCK;
  return service.port && (service.purpose === 'voice' || service.port !== usual)
    ? `${domain}:${service.port}`
    : domain;
}

/**
 * What players type for each of the server's services in NetBird (Java, Bedrock, voice chat), each with a copy button,
 * and a note when someone else holds the port games use without one typed (with the SRV tip for Java).
 */
export function NetbirdAddresses({
  server,
  domain,
}: {
  server: ServerDetail;
  domain: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const services = [...(server.netbird?.services ?? [])]
    .filter((s) => !HIDDEN.includes(s.purpose))
    .sort((a, b) => ORDER.indexOf(a.purpose) - ORDER.indexOf(b.purpose));
  const java = server.edition === 'java';
  if (!services.length) return null;
  return (
    <ul className="grid gap-1.5 rounded-[12px] bg-secondary px-3 py-2 text-[13px]">
      {services.map((s) => {
        const address = playerAddress(s, server, domain);
        return (
          <li key={s.purpose} className="grid gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <Globe className="size-4 text-primary" aria-hidden />
              <span className="text-muted-foreground">{t(`netbirdAuto.purpose.${s.purpose}`)}</span>
              <code className="font-mono font-semibold">{address}</code>
              <CopyButton text={address} className="size-7" />
            </span>
            {s.wanted ? (
              <span className="flex items-start gap-2 text-warning">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  {t('netbirdAuto.portTaken', {
                    wanted: s.wanted,
                    holder: s.heldBy ?? t('netbirdAuto.portTakenSomeone'),
                    address,
                  })}
                  {java && s.purpose === 'main' && s.port
                    ? ` ${t('netbirdAuto.srvHint', {
                        name: `_minecraft._tcp.${domain}`,
                        target: s.domain,
                        port: s.port,
                      })}`
                    : ''}
                </span>
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The server's name in NetBird: typing "survival" is all it takes, the panel sets up the rest. */
export function NetbirdServerField({
  server,
  domain,
}: {
  server: ServerDetail;
  domain: string;
}): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: status } = useQuery(netbirdStatusQuery);
  const [draft, setDraft] = useState(server.netbird?.name ?? '');
  const save = useMutation({
    mutationFn: (name: string | null) =>
      api<{ netbird: NetbirdServerInfo | null }>(`/api/servers/${server.id}/netbird`, {
        method: 'PUT',
        body: { name },
      }),
    onSuccess: async (result) => {
      toast.success(result.netbird ? t('netbirdAuto.serverSaved') : t('netbirdAuto.serverRemoved'));
      setDraft(result.netbird?.name ?? '');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['server', server.id] }),
        queryClient.invalidateQueries({ queryKey: ['connection', server.id] }),
      ]);
    },
  });
  const name = draft.trim();
  const submit = (): void => save.mutate(name || null);
  const failure = save.error ? errorText(save.error) : null;
  const lastError = server.netbird?.error
    ? t(`errors.${server.netbird.error.code}`, server.netbird.error.params)
    : null;

  return (
    <div className="grid gap-2 md:col-span-2">
      <Field
        id={`nb-name-${server.id}`}
        label={t('netbirdAuto.fieldLabel')}
        hint={t('netbirdAuto.fieldHint', brandOf(status))}
      >
        <div className="flex flex-wrap gap-2">
          <NetbirdNameInput
            id={`nb-name-${server.id}`}
            value={draft}
            domain={domain}
            onChange={setDraft}
            onEnter={submit}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={save.isPending || name === (server.netbird?.name ?? '')}
            onClick={submit}
          >
            <Save />
            {save.isPending ? t('netbirdAuto.saving') : t('common.save')}
          </Button>
          {server.netbird ? (
            <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>
              <Trash2 />
              {t('netbirdAuto.remove')}
            </Button>
          ) : null}
        </div>
      </Field>
      {server.netbird?.onDomain ? (
        <span>
          <Pill tone="ok">{t('netbirdAuto.onDomain', { domain })}</Pill>
        </span>
      ) : null}
      <NetbirdAddresses server={server} domain={domain} />
      {(failure ?? lastError) ? (
        <p className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">{failure ?? lastError}</p>
      ) : null}
    </div>
  );
}
