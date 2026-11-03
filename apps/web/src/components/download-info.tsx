import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { ServerLive } from '@mornihosting/shared';
import { formatNumber } from '@/lib/format';

const BYTES_PER_GB = 1024 ** 3;
const BYTES_PER_MB = 1024 ** 2;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

/** "27,0 / 60,0 GB · 35 MB/s · noch ca. 16 Min." while a game downloads its files. */
export function DownloadInfo({ download }: { download: ServerLive['download'] }): ReactElement | null {
  const { t } = useTranslation();
  if (!download) return null;
  const left =
    download.bytesPerSecond && download.bytesPerSecond > 0
      ? (download.totalBytes - download.doneBytes) / download.bytesPerSecond / SECONDS_PER_MINUTE
      : null;
  const eta = (() => {
    if (left === null) return null;
    if (left < 1) return t('download.etaSoon');
    if (left < MINUTES_PER_HOUR) return t('download.etaMinutes', { minutes: Math.ceil(left) });
    return t('download.etaHours', { hours: formatNumber(left / MINUTES_PER_HOUR, 1) });
  })();
  return (
    <span className="tabular text-[12px] text-muted-foreground">
      {formatNumber(download.doneBytes / BYTES_PER_GB, 1)} /{' '}
      {formatNumber(download.totalBytes / BYTES_PER_GB, 1)} GB
      {download.bytesPerSecond ? ` · ${formatNumber(download.bytesPerSecond / BYTES_PER_MB, 1)} MB/s` : ''}
      {eta ? ` · ${eta}` : ''}
    </span>
  );
}
