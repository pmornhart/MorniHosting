import { QueryClientProvider } from '@tanstack/react-query';
import { Suspense, type ReactElement } from 'react';
import { createBrowserRouter, createMemoryRouter, RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/misc';
import { queryClient } from '@/lib/query';
import { AuthGate } from '@/features/auth/AuthGate';
import { ForgotPage, RegisterPage, ResetPage, VerifyPage } from './features/auth/MailPages';
import { LoginPage } from '@/features/auth/LoginPage';
import { SetupPage } from '@/features/auth/SetupPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { AppShell } from '@/features/shell/AppShell';
import { appRoutes } from './routes';
import { lazyPage } from '@/lib/lazy-page';

const PublicStatsPage = lazyPage(async () => ({
  default: (await import('@/features/public/PublicStatsPage')).PublicStatsPage,
}));

/** The demo runs inside a frame where the address bar cannot change, so it keeps its route in memory. */
const createRouter = import.meta.env.MODE === 'demo' ? createMemoryRouter : createBrowserRouter;

const router = createRouter([
  { path: '/setup', element: <SetupPage /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  { path: '/forgot', element: <ForgotPage /> },
  { path: '/reset', element: <ResetPage /> },
  { path: '/verify', element: <VerifyPage /> },
  // Public statistics page of a server (Craft Attack): no login.
  {
    path: '/stats/:slug',
    element: (
      <Suspense fallback={null}>
        <PublicStatsPage />
      </Suspense>
    ),
  },
  {
    element: <AuthGate />,
    children: [
      {
        element: <AppShell />,
        children: [{ index: true, element: <DashboardPage /> }, ...appRoutes],
      },
    ],
  },
]);

const TOAST_MS = 3500;

export function App(): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
        <Toaster
          position="bottom-right"
          duration={TOAST_MS}
          toastOptions={{
            classNames: {
              toast:
                '!rounded-[12px] !border !border-border !bg-popover !text-popover-foreground !shadow-float',
              description: '!text-muted-foreground',
            },
          }}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
