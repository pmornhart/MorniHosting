import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileArchive, Globe, Package, Upload } from 'lucide-react';
import { useRef, useState, type DragEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import {
  CREATABLE_SOFTWARE,
  SOFTWARE,
  recommendedMemoryMb,
  type ImportConfirmInput,
  type ImportDetectionResult,
  type ServerSummary,
  type SoftwareId,
} from '@mornihosting/shared';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Checkbox, Progress } from '@/components/ui/misc';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, upload, type UploadProgress } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { errorText } from '@/lib/query';
import { cn } from '@/lib/utils';
import { hostQuery } from '@/features/dashboard/HostStrip';
import { serversQuery } from '../live';

const FULL = 100;
/** Same ceiling as the server accepts; the list stops at the machine's own RAM. */
const MAX_MEMORY_GB = 128;
const FALLBACK_HOST_GB = 16;
const MB_PER_GB = 1024;
const PORT_SEARCH_LIMIT = 200;
const ZIP_TYPES = '.zip,application/zip';

export function ImportServerPage(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const { data: servers = [] } = useQuery(serversQuery);
  const { data: host } = useQuery(hostQuery);
  const hostGb = host ? Math.floor(host.memoryTotalMb / MB_PER_GB) : FALLBACK_HOST_GB;
  const memoryOptionsGb = Array.from(
    { length: Math.max(1, Math.min(MAX_MEMORY_GB, hostGb)) },
    (_, i) => i + 1,
  );
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [detected, setDetected] = useState<ImportDetectionResult | null>(null);
  const [name, setName] = useState('');
  const [software, setSoftware] = useState<SoftwareId>('paper');
  const [version, setVersion] = useState('');
  const [memoryMb, setMemoryMb] = useState(recommendedMemoryMb('paper'));
  const [port, setPort] = useState<number | null>(null);
  const [eula, setEula] = useState(false);

  const send = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return upload<ImportDetectionResult>('/api/servers/import/upload', form, (p: UploadProgress) =>
        setProgress(p.total ? Math.round((p.loaded / p.total) * FULL) : null),
      );
    },
    onSuccess: (result, file) => {
      setDetected(result);
      setSoftware(result.software);
      setVersion(result.version ?? '');
      setMemoryMb(recommendedMemoryMb(result.software));
      setName(file.name.replace(/\.zip$/i, '')); // eslint-disable-line ts-patterns/require-regex-example -- drops the extension: "Survival.zip" → "Survival"
      setProgress(null);
    },
    onError: () => setProgress(null),
  });

  const defaultPort = SOFTWARE[software].defaultPort;
  const used = new Set(servers.map((s) => s.port));
  const freePort =
    Array.from({ length: PORT_SEARCH_LIMIT }, (_, i) => defaultPort + i).find((p) => !used.has(p)) ??
    defaultPort;
  const chosenPort = port ?? freePort;

  const confirm = useMutation({
    mutationFn: () => {
      const body: ImportConfirmInput = {
        stagingId: detected?.stagingId ?? '',
        name: name.trim(),
        software,
        version: version.trim(),
        memoryMb,
        port: chosenPort,
        eula: true,
        startNow: false,
      };
      return api<ServerSummary>('/api/servers/import/confirm', { method: 'POST', body });
    },
    onSuccess: (server) => {
      void queryClient.invalidateQueries({ queryKey: serversQuery.queryKey });
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      navigate(`/servers/${server.id}`);
    },
    onError: () => undefined,
  });

  const pick = (files: FileList | null): void => {
    const file = files?.[0];
    if (file) send.mutate(file);
  };
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files);
  };

  const allSoftware = [...CREATABLE_SOFTWARE.java, ...CREATABLE_SOFTWARE.bedrock];

  return (
    <>
      <PageHeader title={t('import.title')} subtitle={t('import.subtitle')} />
      {!detected ? (
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'grid justify-items-center gap-3 rounded-[16px] border-2 border-dashed border-input px-6 py-14 text-center transition-colors hover:border-primary',
            dragging && 'border-primary bg-accent',
          )}
        >
          <span className="grid size-12 place-items-center rounded-[14px] bg-accent text-primary">
            <FileArchive className="size-6" />
          </span>
          <b className="text-lg">{t('import.drop')}</b>
          <span className="max-w-[56ch] text-sm text-muted-foreground">
            {t('import.dropHint', { size: '4 GB' })}
          </span>
          {progress !== null ? (
            <span className="grid w-full max-w-sm gap-2">
              <Progress value={progress} />
              <span className="text-sm">{t('import.uploading', { percent: progress })}</span>
            </span>
          ) : null}
          {send.isPending && progress === null ? (
            <span className="text-sm">{t('common.loading')}</span>
          ) : null}
          {send.error ? (
            <span className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">
              {errorText(send.error)}
            </span>
          ) : null}
          <input
            ref={input}
            type="file"
            accept={ZIP_TYPES}
            className="hidden"
            onChange={(e) => pick(e.target.files)}
          />
        </button>
      ) : (
        <Card className="grid gap-5 p-5 sm:p-6">
          <div className="flex flex-wrap gap-3 text-sm">
            <span className="flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 font-semibold">
              {t('import.detected', { software: SOFTWARE[detected.software].label })}
              {detected.version ? ` ${detected.version}` : ''}
            </span>
            <span className="flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5">
              <Upload className="size-4" />
              {t('import.files', { count: detected.files })} · {formatBytes(detected.bytes)}
            </span>
            {detected.worlds.length ? (
              <span className="flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5">
                <Globe className="size-4" />
                {detected.worlds.join(', ')}
              </span>
            ) : null}
            {detected.plugins + detected.mods ? (
              <span className="flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5">
                <Package className="size-4" />
                {detected.plugins + detected.mods}
              </span>
            ) : null}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field id="import-name" label={t('create.name')}>
              <Input id="import-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field id="import-software" label={t('create.stepSoftware')}>
              <Select value={software} onValueChange={(v) => setSoftware(v as SoftwareId)}>
                <SelectTrigger id="import-software">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {allSoftware.map((id) => (
                    <SelectItem key={id} value={id}>
                      {SOFTWARE[id].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="import-version" label={t('create.stepVersion')}>
              <Input
                id="import-version"
                value={version}
                placeholder="1.21.4"
                onChange={(e) => setVersion(e.target.value)}
              />
            </Field>
            <Field id="import-memory" label={t('create.stepSize')}>
              <Select value={String(memoryMb)} onValueChange={(v) => setMemoryMb(Number(v))}>
                <SelectTrigger id="import-memory">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {memoryOptionsGb.map((gb) => (
                    <SelectItem key={gb} value={String(gb * MB_PER_GB)}>
                      {gb} GB
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              id="import-port"
              label={t('create.port')}
              hint={t('create.portHint', { port: defaultPort })}
            >
              <Input
                id="import-port"
                type="number"
                value={chosenPort}
                onChange={(e) => setPort(Number(e.target.value) || null)}
              />
            </Field>
          </div>
          <div className="flex items-center gap-2.5 text-sm">
            <Checkbox id="import-eula" checked={eula} onCheckedChange={(v) => setEula(v === true)} />
            <label htmlFor="import-eula" className="font-semibold">
              {t('create.eula')}
            </label>
          </div>
          {confirm.error ? (
            <p className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">{errorText(confirm.error)}</p>
          ) : null}
          <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-4">
            <Button variant="secondary" onClick={() => setDetected(null)}>
              {t('common.back')}
            </Button>
            <Button
              disabled={!eula || !name.trim() || !version.trim() || confirm.isPending}
              onClick={() => confirm.mutate()}
            >
              <Upload />
              {t('import.submit')}
            </Button>
          </div>
        </Card>
      )}
    </>
  );
}
