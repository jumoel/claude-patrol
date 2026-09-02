import assert from 'node:assert/strict';

/**
 * Assert that `element` has focus, comparing by identity.
 *
 * `assert.equal(document.activeElement, element)` must not be used for this:
 * when it fails, node:assert inspects both DOM nodes (and their React fiber
 * graphs) to build a diff, which exhausts memory inside waitFor and kills the
 * vitest worker with only "Channel closed" printed.
 * @param {Element | null} element
 * @param {string} [message]
 */
export function assertFocused(element, message = 'expected the element to have focus') {
  assert.ok(element !== null && document.activeElement === element, message);
}
