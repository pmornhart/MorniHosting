import { settingsUpdateSchema } from '@mornihosting/shared';
import { actorOf, requireAdmin } from '../auth/context.js';
import type { Api, AppContext } from '../context.js';

/** Panel-wide settings (admins only). Secrets such as the CurseForge key never leave the server. */
export function registerSettingsRoutes(app: Api, ctx: AppContext): void {
  app.get('/api/settings', async (request) => {
    requireAdmin(request);
    return ctx.settings.publicView();
  });

  app.put('/api/settings', { schema: { body: settingsUpdateSchema } }, async (request) => {
    requireAdmin(request);
    const domainBefore = ctx.settings.get().panelDomain;
    ctx.settings.update(request.body);
    const domain = ctx.settings.get().panelDomain;
    // A new panel address reaches the Minecraft servers right away (badge pack, links) – not only at their next start.
    if (domain !== domainBefore) ctx.events.emit('panel.host', { host: domain });
    ctx.audit.record(actorOf(request), 'settings.update', null, {
      changed: Object.keys(request.body).filter(
        (k) => request.body[k as keyof typeof request.body] !== undefined,
      ),
    });
    return ctx.settings.publicView();
  });
}
