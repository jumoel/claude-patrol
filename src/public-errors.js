const AUTHORIZATION_RE = /(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi;
const TOKEN_ASSIGNMENT_RE =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi;
const TOKEN_SHAPE_RE =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[a-z]-[A-Za-z0-9-]{12,})\b/g;
const CREDENTIAL_PATH_RE =
  /(?:~|\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)\/(?:\.claude|\.codex)(?:\/[A-Za-z0-9._/-]+)?/g;

export function truncateUtf8(value, maxBytes) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes - 3) end -= 1;
  return `${text.slice(0, end)}...`;
}

export function sanitizePublicText(value, { maxBytes = 16 * 1024, env = process.env } = {}) {
  let text = String(value ?? '')
    .replace(/\0/g, '')
    .replace(AUTHORIZATION_RE, '$1<redacted>')
    .replace(TOKEN_ASSIGNMENT_RE, '$1=<redacted>')
    .replace(TOKEN_SHAPE_RE, '<redacted-token>')
    .replace(CREDENTIAL_PATH_RE, '<provider-credentials>');

  const secrets = Object.values(env ?? {})
    .filter((candidate) => typeof candidate === 'string' && candidate.length >= 8 && candidate.length <= 4096)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    if (text.includes(secret)) text = text.split(secret).join('<redacted-env>');
  }
  return truncateUtf8(text, maxBytes);
}

function sanitizeValue(value, depth) {
  if (depth > 4) return '<truncated>';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return sanitizePublicText(value, { maxBytes: 4096 });
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 32)) {
      result[sanitizePublicText(key, { maxBytes: 128 })] = sanitizeValue(item, depth + 1);
    }
    return result;
  }
  return sanitizePublicText(value, { maxBytes: 4096 });
}

export function sanitizePublicValue(value) {
  return sanitizeValue(value, 0);
}

export function sanitizeWorkspaceWarnings(warnings) {
  return (warnings ?? []).slice(0, 32).map((warning) => sanitizePublicText(warning, { maxBytes: 4096 }));
}
