/**
 * Embedding MorniHosting's server pages in another app (e.g. MoinMorni, which runs MorniHosting as its "motor"
 * without a web interface of its own: MH_HEADLESS=true).
 *
 * How the other app uses it:
 * 1. `import '<mornihosting>/apps/web/src/i18n'` once (German/English texts; add own texts in an own namespace).
 * 2. `setApiBase('/panel/motor')` – the other app forwards `/panel/motor/api/*` to the motor's `/api/*`, so the
 *    motor's session cookie, CSRF token and passkeys work on the other app's domain.
 * 3. Wrap its router in `QueryClientProvider client={queryClient}` (the same client the pages invalidate) and
 *    `TooltipProvider`; inside the signed-in part put `<SessionProvider me={…}>` with the answer of `meQuery`.
 * 4. Add `serverRoutes` to its router (with a basename such as "/panel": the pages link to "/servers/<id>/…").
 * 5. Optional: the account cards (password, two-factor login, passkeys, e-mail, Minecraft account) for an own
 *    account page, and `ForcePasswordDialog` once inside the signed-in part (asks for an own password after a
 *    start password).
 *
 * Everything the pages fetch, upload, open live or show as a picture goes through `apiUrl`, so step 2 is all it
 * takes to point them at the motor.
 */
import type { RouteObject } from 'react-router';
import { appRoutes } from './routes';

export { setApiBase, apiUrl, api, ApiError } from './lib/api';
export { queryClient } from './lib/query';
export { SessionProvider, meQuery, statusQuery } from './features/auth/session';
export { TooltipProvider } from './components/ui/misc';
export { ServerIcon, StatePill, PlayerHead } from './components/server-visuals';
// Own account (password, two-factor login, passkeys, e-mail, Minecraft account) and the window that asks for an
// own password after signing in with a start password.
export { ProfileCard, PasswordCard, TwoFactorCard } from './features/admin/AccountPage';
export { PasskeysCard } from './features/admin/PasskeysCard';
export { EmailCard } from './features/admin/EmailCard';
export { MinecraftAccountCard } from './features/admin/MinecraftAccountCard';
export { ForcePasswordDialog } from './features/auth/ForcePasswordDialog';

const SERVER_ROUTE = 'servers/:serverId';

/** The server page with all its tabs (console, players, settings, files, version, plugins, backups, …). */
export const serverRoutes: RouteObject[] = appRoutes.filter((r) => r.path === SERVER_ROUTE);
