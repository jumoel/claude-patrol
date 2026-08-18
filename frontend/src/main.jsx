import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './main.css';
import App from './App.jsx';

// A remote-access token is exchanged for an HttpOnly cookie by the server.
// Remove it from the address bar/history as soon as the application loads.
const initialUrl = new URL(window.location.href);
if (initialUrl.searchParams.has('token')) {
  initialUrl.searchParams.delete('token');
  history.replaceState(null, '', `${initialUrl.pathname}${initialUrl.search}${initialUrl.hash}`);
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
