import React from 'react';
import { createRoot } from 'react-dom/client';
import './ui/styles.css';
import { App } from './App.js';

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
