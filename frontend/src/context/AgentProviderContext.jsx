import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { fetchProviderCapabilities } from '../lib/api.js';

const STORAGE_KEY = 'claude-patrol-agent-provider';
const PROVIDERS = new Set(['claude', 'codex']);
const EMPTY_CAPABILITY = Object.freeze({
  available: false,
  checking: true,
  reason: null,
  version: null,
  checkedAt: null,
});

/** @returns {import('../types').AgentProvider} */
function loadProvider() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && PROVIDERS.has(stored)) return /** @type {import('../types').AgentProvider} */ (stored);
  } catch {
    // Storage can be disabled without preventing session launch.
  }
  return 'claude';
}

const AgentProviderContext = createContext(
  /** @type {null | {
   *   provider: import('../types').AgentProvider,
   *   setProvider: (provider: import('../types').AgentProvider) => void,
   *   capabilities: Record<import('../types').AgentProvider, import('../types').ProviderCapability>,
   *   refreshCapabilities: (force?: boolean) => Promise<void>,
   * }} */ (null),
);

/** @param {{children: React.ReactNode}} props */
export function AgentProviderProvider({ children }) {
  const [provider, setProviderState] = useState(loadProvider);
  const [capabilities, setCapabilities] = useState(
    /** @type {Record<import('../types').AgentProvider, import('../types').ProviderCapability>} */ ({
      claude: { ...EMPTY_CAPABILITY },
      codex: { ...EMPTY_CAPABILITY },
    }),
  );

  const setProvider = useCallback(
    /** @param {import('../types').AgentProvider} nextProvider */ (nextProvider) => {
      if (!PROVIDERS.has(nextProvider)) return;
      setProviderState(nextProvider);
      try {
        localStorage.setItem(STORAGE_KEY, nextProvider);
      } catch {
        // The in-memory preference still works for this tab.
      }
    },
    [],
  );

  const refreshCapabilities = useCallback(async (force = false) => {
    setCapabilities((current) => ({
      claude: { ...current.claude, checking: true },
      codex: { ...current.codex, checking: true },
    }));
    try {
      setCapabilities(await fetchProviderCapabilities(force));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setCapabilities({
        claude: { ...EMPTY_CAPABILITY, checking: false, reason },
        codex: { ...EMPTY_CAPABILITY, checking: false, reason },
      });
    }
  }, []);

  useEffect(() => {
    refreshCapabilities();
  }, [refreshCapabilities]);

  useEffect(() => {
    const handleFocus = () => {
      if (Object.values(capabilities).some((capability) => !capability.available)) refreshCapabilities(true);
    };
    /** @param {StorageEvent} event */
    const handleStorage = (event) => {
      if (event.key === STORAGE_KEY && event.newValue && PROVIDERS.has(event.newValue)) {
        setProviderState(/** @type {import('../types').AgentProvider} */ (event.newValue));
      }
    };
    window.addEventListener('focus', handleFocus);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('storage', handleStorage);
    };
  }, [capabilities, refreshCapabilities]);

  useEffect(() => {
    if (Object.values(capabilities).every((capability) => capability.available || capability.checking)) {
      return undefined;
    }
    const timer = setInterval(() => refreshCapabilities(), 60_000);
    return () => clearInterval(timer);
  }, [capabilities, refreshCapabilities]);

  const value = useMemo(
    () => ({ provider, setProvider, capabilities, refreshCapabilities }),
    [provider, setProvider, capabilities, refreshCapabilities],
  );
  return <AgentProviderContext.Provider value={value}>{children}</AgentProviderContext.Provider>;
}

export function useAgentProvider() {
  const value = useContext(AgentProviderContext);
  if (!value) throw new Error('useAgentProvider must be used inside AgentProviderProvider');
  return value;
}
