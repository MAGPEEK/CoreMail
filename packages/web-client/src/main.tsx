import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryCache, MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { toastError } from './lib/errors.js';
import { dropPushOnLogout, registerServiceWorker } from './hooks/useWebPush.js';
import './index.css';

const queryClient = new QueryClient({
  // Global error reporting: every failed query/mutation shows a toast, unless the
  // query opts out via `meta: { silentError: true }` or the mutation handles
  // errors itself (own onError).
  queryCache: new QueryCache({
    onError: (err, query) => {
      if (query.meta?.['silentError']) return;
      toastError(err);
    },
  }),
  mutationCache: new MutationCache({
    onError: (err, _vars, _ctx, mutation) => {
      if (mutation.options.onError || mutation.meta?.['silentError']) return;
      toastError(err);
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

// 9.4: installable webmail + Web Push (public/sw.js; no offline caching)
registerServiceWorker();
dropPushOnLogout();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
          <Toaster position="top-right" toastOptions={{ duration: 3000 }} />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>
);
