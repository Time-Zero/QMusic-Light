import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { CoreProvider } from './app/core-context';
import { ErrorBoundary } from './app/error-boundary';
import { queryClient } from './app/query-client';
import { AppRoutes } from './app/router';
import { useSettingsStore } from './app/settings-store';

export default function App() {
  const theme = useSettingsStore((s) => s.theme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <ErrorBoundary>
      <CoreProvider>
        <QueryClientProvider client={queryClient}>
          <AppRoutes />
        </QueryClientProvider>
      </CoreProvider>
    </ErrorBoundary>
  );
}
