import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, ImageUp, Trash2 } from 'lucide-react';
import { useRef, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ImpressumInfo } from '@mornihosting/shared';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, upload } from '@/lib/api';

export const impressumQuery = {
  queryKey: ['impressum'],
  queryFn: () => api<ImpressumInfo>('/api/public/impressum'),
} as const;

/** The picture's address; the date makes the browser load a new picture after a change. */
export const impressumImageUrl = (info: ImpressumInfo): string =>
  `/api/public/impressum/image?v=${encodeURIComponent(info.updatedAt ?? '')}`;

/** Admin area → Impressum: upload the picture shown at /impressum. */
export function ImpressumSection(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const { data } = useQuery(impressumQuery);
  const save = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file, file.name);
      return upload<ImpressumInfo>('/api/impressum/image', form);
    },
    onSuccess: (info) => {
      queryClient.setQueryData(impressumQuery.queryKey, info);
      toast.success(t('impressum.saved'));
    },
    onSettled: () => {
      if (inputRef.current) inputRef.current.value = '';
    },
  });
  const remove = useMutation({
    mutationFn: () => api<void>('/api/impressum/image', { method: 'DELETE' }),
    onSuccess: () => queryClient.setQueryData(impressumQuery.queryKey, { hasImage: false, updatedAt: null }),
  });

  return (
    <Card className="grid min-w-0 gap-4 p-5 sm:p-6">
      <CardHeader className="mb-0">
        <CardTitle>{t('impressum.title')}</CardTitle>
        <CardDescription>{t('impressum.adminText')}</CardDescription>
      </CardHeader>
      {data?.hasImage ? (
        <img
          src={impressumImageUrl(data)}
          alt={t('impressum.title')}
          className="max-h-96 w-full rounded-[12px] border border-border object-contain"
        />
      ) : (
        <p className="rounded-[12px] border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {t('impressum.none')}
        </p>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) save.mutate(file);
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button disabled={save.isPending} onClick={() => inputRef.current?.click()}>
          <ImageUp />
          {save.isPending
            ? t('impressum.uploading')
            : data?.hasImage
              ? t('impressum.replace')
              : t('impressum.upload')}
        </Button>
        {data?.hasImage ? (
          <>
            <Button variant="outline" asChild>
              <a href="/impressum" target="_blank" rel="noreferrer">
                <ExternalLink />
                {t('impressum.open')}
              </a>
            </Button>
            <Button variant="outline" disabled={remove.isPending} onClick={() => remove.mutate()}>
              <Trash2 />
              {t('impressum.remove')}
            </Button>
          </>
        ) : null}
      </div>
    </Card>
  );
}
