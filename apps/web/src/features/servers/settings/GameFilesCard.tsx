import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, FileUp } from 'lucide-react';
import { useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { GAMES, isGameId, type FileEntry, type ServerDetail } from '@mornihosting/shared';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, upload } from '@/lib/api';
import { toastError } from '@/lib/query';
import { cn } from '@/lib/utils';

function folderOf(file: string): string {
  return file.split('/').slice(0, -1).join('/');
}

function nameOf(file: string): string {
  return file.split('/').at(-1) ?? file;
}

/** Which of the game's required files are uploaded already (they all live in one folder). */
function useRequiredFiles(server: ServerDetail): { missing: string[]; folder: string } | null {
  const required = isGameId(server.software) ? (GAMES[server.software].requiredFiles ?? []) : [];
  const folder = folderOf(required[0] ?? '');
  const { data } = useQuery({
    queryKey: ['files', server.id, folder],
    queryFn: () => api<FileEntry[]>(`/api/servers/${server.id}/files?path=${encodeURIComponent(folder)}`),
    enabled: required.length > 0,
    retry: false,
  });
  if (!required.length) return null;
  const present = new Set((data ?? []).map((f) => f.name));
  return { missing: required.filter((file) => !present.has(nameOf(file))), folder };
}

/**
 * Step-by-step help for files only the game itself can make (ETS2's server packages): how to export them,
 * then one button to upload both to the right folder.
 */
export function GameFilesCard({
  server,
  onlyMissing = false,
}: {
  server: ServerDetail;
  /** On the console page the card only shows while something is missing. */
  onlyMissing?: boolean;
}): ReactElement | null {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const files = useRequiredFiles(server);
  if (!files || !isGameId(server.software)) return null;
  const required = GAMES[server.software].requiredFiles ?? [];
  const done = files.missing.length === 0;
  if (done && onlyMissing) return null;

  const send = async (list: FileList | null): Promise<void> => {
    if (!list?.length) return;
    const form = new FormData();
    Array.from(list).forEach((file) => form.append('file', file, file.name));
    setBusy(true);
    try {
      await upload(`/api/servers/${server.id}/files/upload?path=${encodeURIComponent(files.folder)}`, form);
      toast.success(t('games.files.uploaded'));
      await queryClient.invalidateQueries({ queryKey: ['files', server.id] });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <Card className={cn('p-5 sm:p-6', !done && 'border-warning')}>
      <CardHeader className="mb-1">
        <CardTitle className="flex items-center gap-2">
          {done ? (
            <CheckCircle2 className="size-5 text-success" aria-hidden />
          ) : (
            <CircleAlert className="size-5 text-warning" aria-hidden />
          )}
          {t(`games.${server.software}.filesTitle`)}
        </CardTitle>
      </CardHeader>
      <CardDescription>
        {done ? t('games.files.done') : t(`games.${server.software}.filesText`)}
      </CardDescription>
      {done ? null : (
        <ol className="mt-3 grid list-decimal gap-1.5 pl-5 text-sm">
          {(t(`games.${server.software}.filesSteps`, { returnObjects: true }) as string[]).map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
      <ul className="mt-4 grid gap-1.5 text-sm">
        {required.map((file) => {
          const missing = files.missing.includes(file);
          return (
            <li key={file} className="flex items-center gap-2 font-mono">
              {missing ? (
                <CircleAlert className="size-4 text-warning" aria-hidden />
              ) : (
                <CheckCircle2 className="size-4 text-success" aria-hidden />
              )}
              {nameOf(file)}
            </li>
          );
        })}
      </ul>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={required.map((f) => `.${f.split('.').at(-1) ?? ''}`).join(',')}
        onChange={(e) => void send(e.target.files)}
      />
      <Button
        className="mt-4"
        variant={done ? 'secondary' : 'default'}
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        <FileUp />
        {done ? t('games.files.replace') : t('games.files.upload')}
      </Button>
    </Card>
  );
}
