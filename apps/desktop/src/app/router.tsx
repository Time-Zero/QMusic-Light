import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { features } from './registry';
import { AppShell } from './app-shell';
import { NotFoundPage } from './not-found';

const router = createBrowserRouter([
  {
    path: '/login',
    lazy: async () => ({ Component: (await import('@/features/auth/LoginPage')).default }),
  },
  {
    path: '/',
    element: <AppShell />,
    children: [
      ...features.flatMap((feature) => feature.routes),
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

export function AppRoutes() {
  return <RouterProvider router={router} />;
}
