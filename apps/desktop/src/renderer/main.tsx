import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- JSX intrinsic element typing
  namespace JSX {
    interface IntrinsicElements {
      'hyperframes-player': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        width?: string;
        height?: string;
        'sandbox-origin'?: 'opaque';
      };
    }
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
