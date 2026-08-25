import assert from 'node:assert/strict';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, test } from 'vitest';
import { FloatingPanel } from './FloatingPanel.jsx';

const originalViewport = { width: window.innerWidth, height: window.innerHeight };

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalViewport.width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalViewport.height });
});

function Harness() {
  const anchorRef = useRef(/** @type {HTMLButtonElement | null} */ (null));
  return (
    <div data-testid="clipped-card" style={{ overflow: 'hidden' }}>
      <button ref={anchorRef} type="button">
        Choose provider
      </button>
      <FloatingPanel anchorRef={anchorRef} align="end" data-testid="floating-menu" role="menu">
        Menu content
      </FloatingPanel>
    </div>
  );
}

test('portals floating content outside clipped layout and keeps it in the viewport', async () => {
  render(<Harness />);
  const card = screen.getByTestId('clipped-card');
  const anchor = screen.getByRole('button', { name: 'Choose provider' });
  const menu = screen.getByRole('menu');
  const layer = menu.parentElement;
  assert.ok(layer);
  assert.equal(card.contains(menu), false);
  assert.equal(layer.parentElement, document.body);

  anchor.getBoundingClientRect = () =>
    /** @type {DOMRect} */ ({
      x: 450,
      y: 700,
      top: 700,
      right: 490,
      bottom: 730,
      left: 450,
      width: 40,
      height: 30,
      toJSON() {},
    });
  layer.getBoundingClientRect = () =>
    /** @type {DOMRect} */ ({
      x: 0,
      y: 0,
      top: 0,
      right: 200,
      bottom: 120,
      left: 0,
      width: 200,
      height: 120,
      toJSON() {},
    });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  fireEvent(window, new Event('resize'));

  await waitFor(() => assert.equal(layer.style.top, '576px'));
  assert.equal(layer.style.left, '290px');
  assert.equal(layer.style.visibility, 'visible');
});
