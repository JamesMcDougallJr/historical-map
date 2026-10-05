import type { Page } from "@playwright/test";

/**
 * Native HTML5 drag-and-drop, for LayerControl.tsx's overlay reorder.
 *
 * Playwright's `dragTo()` dispatches pointer events, which LayerControl's
 * `onDragStart`/`onDragEnter`/`onDragOver`/`onDrop` handlers never see —
 * they're registered as real `dragstart`/`dragenter`/`dragover`/`drop`
 * listeners. Constructing a real `DragEvent` + `DataTransfer` inside the page
 * is what actually triggers them.
 */
export async function dragReorderOverlay(
  page: Page,
  draggedId: string,
  targetId: string,
): Promise<void> {
  const draggedTestId = `overlay-row-${draggedId}`;
  const targetTestId = `overlay-row-${targetId}`;

  // One page.evaluate per event, not all five in one synchronous call:
  // handleDragStart's setDraggedId(id) only takes effect once React commits
  // and re-renders, and drop's handler reads `draggedId` through a closure
  // captured at render time. Firing every event in one tick with no yield
  // back to the event loop meant drop always read the pre-drag (null)
  // closure value and hit its `if (!draggedId) return` guard — the reorder
  // silently never happened, the symptom this bug actually had.
  // All five events must share one DataTransfer, the same as a real drag —
  // stashed on `window` since it has to survive across separate
  // page.evaluate calls, each a fresh round-trip into the page.
  type DndWindow = Window & { __dndDataTransfer?: DataTransfer };

  const fire = (testId: string, type: string, isLast = false) =>
    page.evaluate(
      ({ testId, type, isLast }) => {
        const el = document.querySelector(`[data-testid="${testId}"]`);
        if (!el) throw new Error(`drag element not found: ${testId}`);
        const w = window as DndWindow;
        w.__dndDataTransfer ??= new DataTransfer();
        el.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: w.__dndDataTransfer,
          }),
        );
        if (isLast) delete w.__dndDataTransfer;
      },
      { testId, type, isLast },
    );

  await fire(draggedTestId, "dragstart");
  await fire(targetTestId, "dragenter");
  await fire(targetTestId, "dragover");
  await fire(targetTestId, "drop");
  await fire(draggedTestId, "dragend", true);
}
