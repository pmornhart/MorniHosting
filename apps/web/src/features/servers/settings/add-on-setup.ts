import type { AddOnKey, ServerDetail } from '@mornihosting/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

/**
 * True while the panel still sets up an add-on chosen at the order. When it is done, the server is loaded
 * again so the switch shows the real state (on, with its port).
 */
export function useAddOnSetup(server: ServerDetail, key: AddOnKey): boolean {
  const queryClient = useQueryClient();
  const busy = server.live.setup?.pending.includes(key) ?? false;
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      void queryClient.invalidateQueries({ queryKey: ['server', server.id] });
      void queryClient.invalidateQueries({ queryKey: ['content', server.id] });
    }
    wasBusy.current = busy;
  }, [busy, queryClient, server.id]);
  return busy;
}
