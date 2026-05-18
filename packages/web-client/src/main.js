import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { App } from './App.js';
import './index.css';
const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 30_000,
            retry: 1,
        },
    },
});
createRoot(document.getElementById('root')).render(_jsx(StrictMode, { children: _jsx(QueryClientProvider, { client: queryClient, children: _jsxs(BrowserRouter, { basename: "/owa", children: [_jsx(App, {}), _jsx(Toaster, { position: "top-right", toastOptions: { duration: 3000 } })] }) }) }));
