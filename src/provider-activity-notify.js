import { pathToFileURL } from 'node:url';

export function parseCodexNotification(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (payload?.type !== 'agent-turn-complete' || typeof payload['turn-id'] !== 'string') return null;
  return { event: 'turn_completed', run_id: payload['turn-id'] };
}

export function parseClaudeNotification(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof payload?.hook_event_name !== 'string') return null;
  return {
    hook_event_name: payload.hook_event_name,
    ...(typeof payload.prompt_id === 'string' ? { prompt_id: payload.prompt_id } : {}),
    ...(typeof payload.tool_name === 'string' ? { tool_name: payload.tool_name } : {}),
  };
}

export async function sendProviderActivityNotification({
  provider,
  raw,
  url = process.env.PATROL_ACTIVITY_URL,
  token = process.env.PATROL_ACTIVITY_TOKEN,
  fetchImpl = fetch,
  timeoutMs = 1_000,
} = {}) {
  const payload =
    provider === 'codex' ? parseCodexNotification(raw) : provider === 'claude' ? parseClaudeNotification(raw) : null;
  if (!payload || !url || !token) return false;
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  const provider = process.argv[2];
  let raw = process.argv.at(-1);
  if (provider === 'claude') {
    raw = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;
  }
  await sendProviderActivityNotification({ provider, raw });
}
