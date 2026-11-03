import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  Download,
  FileArchive,
  FilePlus2,
  FolderInput,
  FolderPlus,
  House,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { Suspense, useRef, useState, type DragEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import type { FileEntry, TrashEntry } from '@mornihosting/shared';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { NameDialog } from '@/components/name-dialog';
import { EmptyState } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Checkbox, Progress, Skeleton } from '@/components/ui/misc';
import { api, upload, type UploadProgress } from '@/lib/api';
import { formatBytes, formatRelative } from '@/lib/format';
import { toastError } from '@/lib/query';
import { lazyPage } from '@/lib/lazy-page';
import { cn } from '@/lib/utils';
import { useServer } from '../ServerLayout';
import { downloadUrl, iconFor, isEditable, isZip, joinPath, parentOf } from './file-kinds';
import { FolderTree } from './FolderTree';
import { TrashDialog } from './TrashDialog';

const FileEditor = lazyPage(() => import('./FileEditor'));

const PERCENT = 100;

type NameAction = { kind: 'mkdir' | 'newfile' | 'zip' } | { kind: 'rename'; entry: FileEntry };

// Characters not allowed in a suggested file name: in "Lenas Welt!" it matches "!".
// https://regex101.com/?regex=%5B%5E%5Cw%20.-%5D%2B&flags=g&testString=Lenas%20Welt!
const UNSAFE_NAME_CHARS = /[^\w .-]+/g;

function initialName(action: NameAction | null, serverName: string): string {
  if (action?.kind === 'rename') return action.entry.name;
  if (action?.kind === 'zip') return `${serverName.replace(UNSAFE_NAME_CHARS, '_')}.zip`;
  return '';
}

const filesQuery = (serverId: string, dir: string) =>
  ({
    queryKey: ['files', serverId, dir],
    queryFn: () => api<FileEntry[]>(`/api/servers/${serverId}/files?path=${encodeURIComponent(dir)}`),
  }) as const;

function Breadcrumbs({ dir, onOpen }: { dir: string; onOpen: (dir: string) => void }): ReactElement {
  const { t } = useTranslation();
  const parts = dir ? dir.split('/') : [];
  return (
    <nav
      aria-label={t('files.location')}
      className="flex min-w-0 basis-full flex-wrap items-center gap-0.5 text-sm sm:flex-1 sm:basis-auto"
    >
      <button
        type="button"
        onClick={() => onOpen('')}
        className="inline-flex items-center gap-1.5 rounded-[8px] px-2 py-1 font-semibold hover:bg-secondary"
      >
        <House className="size-4 text-muted-foreground" aria-hidden />
        {t('files.root')}
      </button>
      {parts.map((part, i) => (
        <span key={parts.slice(0, i + 1).join('/')} className="inline-flex items-center gap-0.5">
          <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />
          <button
            type="button"
            onClick={() => onOpen(parts.slice(0, i + 1).join('/'))}
            className={cn(
              'max-w-[22ch] truncate rounded-[8px] px-2 py-1 hover:bg-secondary',
              i === parts.length - 1 ? 'font-semibold' : 'text-muted-foreground',
            )}
          >
            {part}
          </button>
        </span>
      ))}
    </nav>
  );
}

function FileBrowser({
  dir,
  onOpenDir,
  onEdit,
}: {
  dir: string;
  onOpenDir: (dir: string) => void;
  onEdit: (path: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const { server } = useServer();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [nameAction, setNameAction] = useState<NameAction | null>(null);
  const [deleting, setDeleting] = useState<readonly string[] | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<(UploadProgress & { names: string }) | null>(null);
  const { data: entries, isPending, error, refetch, isFetching } = useQuery(filesQuery(server.id, dir));
  const { data: trash } = useQuery({
    queryKey: ['trash', server.id],
    queryFn: () => api<TrashEntry[]>(`/api/servers/${server.id}/trash`),
  });
  const base = `/api/servers/${server.id}`;
  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['files', server.id] }),
      queryClient.invalidateQueries({ queryKey: ['trash', server.id] }),
    ]);
  };

  const remove = useMutation({
    mutationFn: (paths: readonly string[]) =>
      api<{ moved: number }>(`${base}/files/delete`, { method: 'POST', body: { paths } }),
    onSuccess: async (result) => {
      toast.success(t('files.movedToTrash', { count: result.moved }));
      setSelected(new Set());
      await refresh();
    },
  });
  const unzip = useMutation({
    mutationFn: (entry: FileEntry) =>
      api<{ files: number }>(`${base}/files/unzip`, {
        method: 'POST',
        body: { path: entry.path, destination: dir },
      }),
    onSuccess: async (result) => {
      toast.success(t('files.unzipped', { count: result.files }));
      await refresh();
    },
  });

  const uploadFiles = async (files: readonly File[]): Promise<void> => {
    if (!files.length) return;
    const form = new FormData();
    files.forEach((file) => form.append('file', file, file.name));
    const names = files.map((f) => f.name).join(', ');
    setProgress({ loaded: 0, total: 1, names });
    try {
      await upload<FileEntry[]>(`${base}/files/upload?path=${encodeURIComponent(dir)}`, form, (p) =>
        setProgress({ ...p, names }),
      );
      toast.success(t('files.uploaded', { count: files.length }));
      await refresh();
    } catch (err) {
      toastError(err);
    } finally {
      setProgress(null);
    }
  };

  const submitName = async (name: string): Promise<void> => {
    if (!nameAction) return;
    const actions: Readonly<Record<NameAction['kind'], () => Promise<unknown>>> = {
      mkdir: () => api(`${base}/files/mkdir`, { method: 'POST', body: { path: joinPath(dir, name) } }),
      newfile: async () => {
        await api(`${base}/files/content`, {
          method: 'PUT',
          body: { path: joinPath(dir, name), content: '' },
        });
        onEdit(joinPath(dir, name));
      },
      zip: () =>
        api(`${base}/files/zip`, {
          method: 'POST',
          body: { paths: [...selected], name: name.endsWith('.zip') ? name : `${name}.zip` },
        }),
      rename: () =>
        nameAction.kind === 'rename'
          ? api(`${base}/files/rename`, {
              method: 'POST',
              body: { from: nameAction.entry.path, to: joinPath(dir, name) },
            })
          : Promise.resolve(),
    };
    try {
      await actions[nameAction.kind]();
      if (nameAction.kind === 'zip') setSelected(new Set());
      await refresh();
    } catch (err) {
      toastError(err);
      throw err;
    }
  };

  const open = (entry: FileEntry): void => {
    if (entry.type === 'dir') onOpenDir(entry.path);
    else if (isEditable(entry)) onEdit(entry.path);
    else window.location.assign(downloadUrl(server.id, entry.path));
  };
  const toggle = (path: string, on: boolean): void =>
    setSelected((prev) => new Set(on ? [...prev, path] : [...prev].filter((p) => p !== path)));
  const allSelected = Boolean(entries?.length) && entries?.every((e) => selected.has(e.path));

  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    setDragging(false);
    void uploadFiles([...e.dataTransfer.files]);
  };

  const listBody = (): ReactElement => {
    if (isPending) {
      return (
        <div className="grid gap-2 p-4">
          {['a', 'b', 'c', 'd'].map((k) => (
            <Skeleton key={k} className="h-10" />
          ))}
        </div>
      );
    }
    if (error) {
      return (
        <EmptyState
          className="m-4"
          title={t('files.loadFailed')}
          action={<Button onClick={() => onOpenDir('')}>{t('files.toRoot')}</Button>}
        />
      );
    }
    if (!entries.length && !dir) {
      return (
        <EmptyState
          className="m-4"
          icon={<Upload />}
          title={t('files.emptyTitle')}
          text={t('files.emptyText')}
        />
      );
    }
    return (
      <table className="w-full text-sm">
        <thead className="text-left text-[12px] uppercase tracking-wide text-muted-foreground">
          <tr className="border-b border-border">
            <th className="w-10 py-2 pl-4">
              <Checkbox
                aria-label={t('files.selectAll')}
                checked={allSelected}
                onCheckedChange={(on) => setSelected(new Set(on === true ? entries.map((e) => e.path) : []))}
              />
            </th>
            <th className="w-full py-2 font-semibold">{t('common.name')}</th>
            <th className="hidden py-2 text-right font-semibold sm:table-cell">{t('files.size')}</th>
            <th className="hidden py-2 pl-6 font-semibold md:table-cell">{t('files.modified')}</th>
            <th className="w-12 py-2 pr-3">
              <span className="sr-only">{t('common.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {dir ? (
            <tr className="border-b border-border/60 hover:bg-secondary/50">
              <td />
              <td colSpan={4} className="py-1.5">
                <button
                  type="button"
                  className="inline-flex items-center gap-2.5 rounded-[8px] px-1 py-1 text-muted-foreground hover:text-foreground"
                  onClick={() => onOpenDir(parentOf(dir))}
                >
                  <FolderInput className="size-[18px]" aria-hidden />
                  {t('files.up')}
                </button>
              </td>
            </tr>
          ) : null}
          {entries.map((entry) => {
            const Icon = iconFor(entry);
            return (
              <tr
                key={entry.path}
                className={cn(
                  'border-b border-border/60 last:border-0 hover:bg-secondary/50',
                  selected.has(entry.path) && 'bg-accent/50',
                )}
              >
                <td className="py-1.5 pl-4">
                  <Checkbox
                    aria-label={t('files.select', { name: entry.name })}
                    checked={selected.has(entry.path)}
                    onCheckedChange={(on) => toggle(entry.path, on === true)}
                  />
                </td>
                <td className="max-w-0 py-1.5">
                  <button
                    type="button"
                    onClick={() => open(entry)}
                    className="flex w-full min-w-0 items-center gap-2.5 rounded-[8px] px-1 py-1 text-left font-medium hover:text-primary"
                  >
                    <Icon
                      className={cn(
                        'size-[18px] shrink-0',
                        entry.type === 'dir' ? 'text-primary' : 'text-muted-foreground',
                      )}
                      aria-hidden
                    />
                    <span className="truncate">{entry.name}</span>
                  </button>
                </td>
                <td className="tabular hidden py-1.5 text-right text-muted-foreground sm:table-cell">
                  {entry.type === 'file' ? formatBytes(entry.size) : ''}
                </td>
                <td className="hidden whitespace-nowrap py-1.5 pl-6 text-muted-foreground md:table-cell">
                  {formatRelative(entry.modifiedAt)}
                </td>
                <td className="py-1.5 pr-3 text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('files.actionsFor', { name: entry.name })}
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {isEditable(entry) ? (
                        <DropdownMenuItem onSelect={() => onEdit(entry.path)}>
                          <Pencil />
                          {t('common.edit')}
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem asChild>
                        <a href={downloadUrl(server.id, entry.path)} download>
                          <Download />
                          {entry.type === 'dir' ? t('files.downloadZip') : t('common.download')}
                        </a>
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setNameAction({ kind: 'rename', entry })}>
                        <Pencil />
                        {t('common.rename')}
                      </DropdownMenuItem>
                      {isZip(entry) ? (
                        <DropdownMenuItem onSelect={() => unzip.mutate(entry)}>
                          <FolderInput />
                          {t('files.unzipHere')}
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem
                          onSelect={() => {
                            setSelected(new Set([entry.path]));
                            setNameAction({ kind: 'zip' });
                          }}
                        >
                          <FileArchive />
                          {t('files.zip')}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem destructive onSelect={() => setDeleting([entry.path])}>
                        <Trash2 />
                        {t('common.delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              </tr>
            );
          })}
          {entries.length ? null : (
            <tr>
              <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground">
                {t('files.emptyFolder')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    );
  };

  return (
    <Card
      className="relative overflow-hidden"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <Breadcrumbs dir={dir} onOpen={onOpenDir} />
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" onClick={() => inputRef.current?.click()}>
            <Upload />
            {t('common.upload')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setNameAction({ kind: 'mkdir' })}>
            <FolderPlus />
            <span className="max-sm:sr-only">{t('files.newFolder')}</span>
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setNameAction({ kind: 'newfile' })}>
            <FilePlus2 />
            <span className="max-sm:sr-only">{t('files.newFile')}</span>
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setTrashOpen(true)}>
            <Trash2 />
            <span className="max-sm:sr-only">{t('files.trash')}</span>
            {trash?.length ? (
              <span className="tabular rounded-full bg-muted px-1.5 text-[11px]">{trash.length}</span>
            ) : null}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('common.refresh')}
            onClick={() => void refetch()}
          >
            <RefreshCw className={cn(isFetching && 'animate-spin')} />
          </Button>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void uploadFiles([...(e.target.files ?? [])]);
            if (inputRef.current) inputRef.current.value = '';
          }}
        />
      </div>

      {progress ? (
        <div className="grid gap-2 border-b border-border bg-accent/40 px-4 py-3" role="status">
          <div className="flex items-center justify-between gap-3 text-[13px]">
            <span className="min-w-0 truncate font-semibold">
              {t('files.uploading', { names: progress.names })}
            </span>
            <span className="tabular text-muted-foreground">
              {Math.round((progress.loaded / Math.max(progress.total, 1)) * PERCENT)} %
            </span>
          </div>
          <Progress value={(progress.loaded / Math.max(progress.total, 1)) * PERCENT} />
        </div>
      ) : null}

      {selected.size ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-secondary/60 px-4 py-2 text-[13px]">
          <b className="font-semibold">{t('files.selected', { count: selected.size })}</b>
          <span className="flex-1" />
          <Button size="sm" variant="secondary" onClick={() => setNameAction({ kind: 'zip' })}>
            <FileArchive />
            {t('files.zip')}
          </Button>
          <Button size="sm" variant="destructive" onClick={() => setDeleting([...selected])}>
            <Trash2 />
            {t('common.delete')}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('files.clearSelection')}
            onClick={() => setSelected(new Set())}
          >
            <X />
          </Button>
        </div>
      ) : null}

      {listBody()}

      {dragging ? (
        <div className="pointer-events-none absolute inset-2 grid place-items-center rounded-[14px] border-2 border-dashed border-primary bg-background/85 text-center">
          <div className="grid justify-items-center gap-2">
            <Upload className="size-8 text-primary" aria-hidden />
            <b className="text-base">{t('files.dropHere')}</b>
            <span className="text-sm text-muted-foreground">{dir ? `/${dir}` : t('files.root')}</span>
          </div>
        </div>
      ) : null}

      <NameDialog
        open={nameAction !== null}
        onOpenChange={(o) => !o && setNameAction(null)}
        title={t(`files.dialog.${nameAction?.kind ?? 'mkdir'}`)}
        label={t('common.name')}
        initial={initialName(nameAction, server.name)}
        confirmLabel={nameAction?.kind === 'rename' ? t('common.rename') : t('common.create')}
        onSubmit={submitName}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('files.deleteTitle', { count: deleting?.length ?? 0 })}
        description={t('files.deleteText')}
        confirmLabel={t('files.moveToTrash')}
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting);
        }}
      />
      <TrashDialog
        open={trashOpen}
        onOpenChange={setTrashOpen}
        serverId={server.id}
        entries={trash ?? []}
        onChanged={refresh}
      />
    </Card>
  );
}

export default function FilesTab(): ReactElement {
  const { t } = useTranslation();
  const { server, can } = useServer();
  const [params, setParams] = useSearchParams();
  const dir = params.get('path') ?? '';
  const editing = params.get('edit');
  if (!can('files')) return <EmptyState title={t('server.noPermission')} />;

  const openDir = (next: string): void => setParams(next ? { path: next } : {});
  const edit = (path: string): void => setParams({ ...(dir ? { path: dir } : {}), edit: path });

  if (editing) {
    return (
      <Suspense fallback={<Skeleton className="h-[480px] rounded-[16px]" />}>
        <FileEditor serverId={server.id} path={editing} onClose={() => openDir(parentOf(editing))} />
      </Suspense>
    );
  }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[230px_minmax(0,1fr)]">
      <Card className="sticky top-4 hidden max-h-[calc(100dvh-120px)] overflow-y-auto p-2 lg:block">
        <FolderTree serverId={server.id} current={dir} onOpen={openDir} />
      </Card>
      <FileBrowser key={dir} dir={dir} onOpenDir={openDir} onEdit={edit} />
    </div>
  );
}
