import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
// The repository typecheck intentionally omits the JSX compiler option; Vite
// still resolves this required .tsx entry module for the browser build.
// @ts-expect-error TS6142 is expected under tsconfig.test.json.
import App from './App.js';

type RootContainer = Parameters<typeof createRoot>[0];
const documentLike = (globalThis as unknown as {
  document?: { getElementById(id: string): RootContainer | null };
}).document;
const root = documentLike?.getElementById('root');
if (!root) throw new Error('Crosstalk hub requires a #root element');

createRoot(root).render(
  createElement(App),
);
