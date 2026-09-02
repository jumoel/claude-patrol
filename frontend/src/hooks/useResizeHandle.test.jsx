import assert from 'node:assert/strict';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';
import { useResizeHandle } from './useResizeHandle.js';

// jsdom 26 ships neither PointerEvent nor Element#setPointerCapture. Back the
// pointer events with MouseEvent so React's pointer handlers receive clientY,
// and record capture requests so the test can assert on them.
class TestPointerEvent extends MouseEvent {
  /** @param {string} type @param {PointerEventInit} [init] */
  constructor(type, init = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}
Object.defineProperty(window, 'PointerEvent', { configurable: true, writable: true, value: TestPointerEvent });
const setPointerCapture = vi.fn();
Element.prototype.setPointerCapture = setPointerCapture;

/** @param {Parameters<typeof useResizeHandle>[0]} props */
function Handle(props) {
  const { height, dragging, handleProps, setHeight } = useResizeHandle(props);
  return (
    <div>
      <div data-testid="handle" data-height={height} data-dragging={dragging} {...handleProps} />
      <button type="button" onClick={() => setHeight(333)}>
        set height
      </button>
    </div>
  );
}

function handle() {
  return screen.getByTestId('handle');
}

function heightOf() {
  return Number(handle().getAttribute('data-height'));
}

function isDragging() {
  return handle().getAttribute('data-dragging') === 'true';
}

beforeEach(() => {
  setPointerCapture.mockReset();
});

test('dragging down grows a top-anchored handle, clamped to min and max, and persists on release', () => {
  const onPersist = vi.fn();
  render(<Handle initial={200} min={100} max={400} onPersist={onPersist} />);
  assert.equal(heightOf(), 200);
  assert.equal(isDragging(), false);

  fireEvent.pointerDown(handle(), { clientY: 100, pointerId: 7 });
  assert.equal(isDragging(), true);
  assert.deepEqual(setPointerCapture.mock.calls, [[7]]);

  fireEvent.pointerMove(handle(), { clientY: 150 });
  assert.equal(heightOf(), 250);
  fireEvent.pointerMove(handle(), { clientY: 900 });
  assert.equal(heightOf(), 400, 'clamped to max');
  fireEvent.pointerMove(handle(), { clientY: -900 });
  assert.equal(heightOf(), 100, 'clamped to min');
  fireEvent.pointerMove(handle(), { clientY: 130 });
  assert.equal(heightOf(), 230);
  assert.equal(onPersist.mock.calls.length, 0, 'nothing is persisted mid-drag');

  fireEvent.pointerUp(handle());
  assert.equal(isDragging(), false);
  assert.deepEqual(onPersist.mock.calls, [[230]]);

  fireEvent.pointerMove(handle(), { clientY: 300 });
  assert.equal(heightOf(), 230, 'moves after release are ignored');
  fireEvent.pointerUp(handle());
  assert.equal(onPersist.mock.calls.length, 1, 'a release without a drag is a no-op');
});

test('direction up inverts the drag so moving the pointer up grows the height', () => {
  render(<Handle initial={200} min={50} max={500} direction="up" />);

  fireEvent.pointerDown(handle(), { clientY: 300, pointerId: 1 });
  fireEvent.pointerMove(handle(), { clientY: 250 });
  assert.equal(heightOf(), 250);
  fireEvent.pointerMove(handle(), { clientY: 400 });
  assert.equal(heightOf(), 100);
  fireEvent.pointerMove(handle(), { clientY: -500 });
  assert.equal(heightOf(), 500, 'clamped to max');

  fireEvent.pointerUp(handle());
  assert.equal(isDragging(), false);
  assert.equal(heightOf(), 500);
});

test('pointercancel ends the drag like a release, and setHeight is exposed to callers', () => {
  const onPersist = vi.fn();
  render(<Handle initial={120} min={100} max={400} onPersist={onPersist} />);

  fireEvent.pointerDown(handle(), { clientY: 0, pointerId: 3 });
  fireEvent.pointerMove(handle(), { clientY: 40 });
  assert.equal(heightOf(), 160);
  fireEvent.pointerCancel(handle());
  assert.equal(isDragging(), false);
  assert.deepEqual(onPersist.mock.calls, [[160]]);

  fireEvent.click(screen.getByRole('button', { name: 'set height' }));
  assert.equal(heightOf(), 333);
  assert.equal(onPersist.mock.calls.length, 1, 'setHeight does not persist');

  fireEvent.pointerDown(handle(), { clientY: 10, pointerId: 3 });
  fireEvent.pointerMove(handle(), { clientY: 20 });
  assert.equal(heightOf(), 343, 'the next drag starts from the programmatic height');
});
