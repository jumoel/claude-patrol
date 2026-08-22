import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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

/** @returns {{ provider: import('../types').AgentProvider, stored: boolean }} */
function loadProviderPreference() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && PROVIDERS.has(stored)) {
      return { provider: /** @type {import('../types').AgentProvider} */ (stored), stored: true };
    }
  } catch {
    // Storage can be disabled without preventing session launch.
  }
  return { provider: 'claude', stored: false };
}

const AgentProviderContext = createContext(
  /** @type {null | {
   *   provider: import('../types').AgentProvider,
   *   setProvider: (provider: import('../types').AgentProvider) => void,
   *   applyInstanceDefault: (provider: import('../types').AgentProvider) => void,
   *   capabilities: Record<import('../types').AgentProvider, import('../types').ProviderCapability>,
   *   refreshCapabilities: (force?: boolean) => Promise<void>,
   * }} */ (null),
);

/** @param {{children: React.ReactNode}} props */
export function AgentProviderProvider({ children }) {
  const [initialPreference] = useState(loadProviderPreference);
  const [provider, setProviderState] = useState(initialPreference.provider);
  const hasStoredProvider = useRef(initialPreference.stored);
  const instanceDefaultProvider = useRef(/** @type {import('../types').AgentProvider} */ ('claude'));
  const [capabilities, setCapabilities] = useState(
    /** @type {Record<import('../types').AgentProvider, import('../types').ProviderCapability>} */ ({
      claude: { ...EMPTY_CAPABILITY },
      codex: { ...EMPTY_CAPABILITY },
    }),
  );

  const setProvider = useCallback(
    /** @param {import('../types').AgentProvider} nextProvider */ (nextProvider) => {
      if (!PROVIDERS.has(nextProvider)) return;
      hasStoredProvider.current = true;
      setProviderState(nextProvider);
      try {
        localStorage.setItem(STORAGE_KEY, nextProvider);
      } catch {
        // The in-memory preference still works for this tab.
      }
    },
    [],
  );

  const applyInstanceDefault = useCallback(
    /** @param {import('../types').AgentProvider} nextProvider */ (nextProvider) => {
      if (!PROVIDERS.has(nextProvider)) return;
      instanceDefaultProvider.current = nextProvider;
      if (!hasStoredProvider.current) setProviderState(nextProvider);
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
      if (event.key !== STORAGE_KEY && event.key !== null) return;
      if (event.newValue && PROVIDERS.has(event.newValue)) {
        hasStoredProvider.current = true;
        setProviderState(/** @type {import('../types').AgentProvider} */ (event.newValue));
      } else if (event.newValue === null) {
        hasStoredProvider.current = false;
        setProviderState(instanceDefaultProvider.current);
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
    () => ({ provider, setProvider, applyInstanceDefault, capabilities, refreshCapabilities }),
    [provider, setProvider, applyInstanceDefault, capabilities, refreshCapabilities],
  );
  return <AgentProviderContext.Provider value={value}>{children}</AgentProviderContext.Provider>;
}

export function useAgentProvider() {
  const value = useContext(AgentProviderContext);
  if (!value) throw new Error('useAgentProvider must be used inside AgentProviderProvider');
  return value;
}
