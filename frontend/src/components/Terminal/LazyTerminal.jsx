import { lazy, Suspense } from 'react';
import shared from '../../styles/shared.module.css';
import { LoadingIndicator } from '../ui/LoadingIndicator/LoadingIndicator.jsx';

const Terminal = lazy(() => import('./Terminal.jsx').then((module) => ({ default: module.Terminal })));

/** @param {React.ComponentProps<typeof import('./Terminal.jsx').Terminal>} props */
export function LazyTerminal(props) {
  return (
    <Suspense fallback={<LoadingIndicator className={shared.terminalLoading}>Loading terminal...</LoadingIndicator>}>
      <Terminal {...props} />
    </Suspense>
  );
}
