import { useAgentProvider } from '../../context/AgentProviderContext.jsx';
import styles from './AgentProviderSelect.module.css';

/**
 * @param {{
 *   disabled?: boolean,
 *   value?: import('../../types').AgentProvider,
 *   dark?: boolean,
 *   className?: string,
 * }} props
 */
export function AgentProviderSelect({ disabled = false, value, dark = false, className = '' }) {
  const { provider, setProvider } = useAgentProvider();
  return (
    <select
      className={`${styles.select} ${dark ? styles.dark : ''} ${className}`}
      aria-label="Agent provider for new sessions"
      title={disabled ? 'Kill the current session before changing its provider' : 'Choose the agent for new sessions'}
      value={value ?? provider}
      onChange={(event) => setProvider(/** @type {import('../../types').AgentProvider} */ (event.target.value))}
      disabled={disabled}
    >
      <option value="claude">Claude</option>
      <option value="codex">Codex</option>
    </select>
  );
}
