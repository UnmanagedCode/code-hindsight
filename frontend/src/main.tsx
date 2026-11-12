import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

// A CP link to its own root lands on this shell inside the CP frame; send that frame back to the CP.
if (window.frameElement?.hasAttribute('data-cp-frame')) {
  location.replace('dashboard');
} else {
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
}
