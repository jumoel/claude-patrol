import { lazy, Suspense } from 'react';
import shared from '../../styles/shared.module.css';

const Terminal = lazy(() => import('./Terminal.jsx').then((module) => ({ default: module.Terminal })));

/** @param {React.ComponentProps<typeof import('./Terminal.jsx').Terminal>} props */
export function LazyTerminal(props) {
  return (
    <Suspense
      fallback={
        <div className={shared.terminalLoading} role="status">
          <span className={shared.terminalSpinner} aria-hidden="true" />
          Loading terminal...
        </div>
      }
    >
      <Terminal {...props} />
    </Suspense>
  );
}
