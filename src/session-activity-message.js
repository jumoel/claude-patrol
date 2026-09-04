import { taggedError } from './errors.js';
import { sanitizePublicText } from './public-errors.js';

export const MAX_SESSION_ACTIVITY_MESSAGE_LENGTH = 64;

function truncateWithoutSplittingCharacters(value, maxLength) {
  let result = '';
  for (const character of value) {
    if (result.length + character.length > maxLength) break;
    result += character;
  }
  return result;
}

export function normalizeSessionActivityMessage(value) {
  if (typeof value !== 'string') {
    throw taggedError('invalid_activity_message', 'Activity message must be a string');
  }
  const singleLine = value
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!singleLine) throw taggedError('invalid_activity_message', 'Activity message is required');
  if (/[\p{Cc}\p{Cf}]/u.test(singleLine)) {
    throw taggedError('invalid_activity_message', 'Activity message cannot contain control characters');
  }
  if (singleLine.length > MAX_SESSION_ACTIVITY_MESSAGE_LENGTH) {
    throw taggedError(
      'invalid_activity_message',
      `Activity message cannot exceed ${MAX_SESSION_ACTIVITY_MESSAGE_LENGTH} characters`,
    );
  }
  const sanitized = sanitizePublicText(singleLine, { maxBytes: 256 });
  return truncateWithoutSplittingCharacters(sanitized, MAX_SESSION_ACTIVITY_MESSAGE_LENGTH).trim();
}
