import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { BrandMark } from '@/components/server-visuals';
import { Skeleton } from '@/components/ui/misc';
import { impressumImageUrl, impressumQuery } from '@/features/admin/ImpressumSection';

/** /impressum: the picture an admin uploaded, for everybody, also without logging in. */
export function ImpressumPage(): ReactElement {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery(impressumQuery);
  return (
    <main className="min-h-dvh bg-background px-4 py-10">
      <div className="mx-auto grid max-w-3xl gap-6">
        <Link to="/" className="flex w-fit items-center gap-2 text-sm font-semibold text-muted-foreground">
          <ArrowLeft className="size-4" aria-hidden />
          <BrandMark className="size-6" />
          MorniHosting
        </Link>
        <h1 className="text-3xl font-extrabold tracking-tight">{t('impressum.title')}</h1>
        {isLoading ? (
          <Skeleton className="h-96" />
        ) : data?.hasImage ? (
          <img
            src={impressumImageUrl(data)}
            alt={t('impressum.title')}
            className="w-full rounded-[16px] border border-border object-contain"
          />
        ) : (
          <p className="text-muted-foreground">{t('impressum.none')}</p>
        )}
      </div>
    </main>
  );
}
