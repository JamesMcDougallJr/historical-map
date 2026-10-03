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
  await page.evaluate(
    ({ draggedTestId, targetTestId }) => {
      const dt = new DataTransfer();
      const source = document.querySelector(`[data-testid="${draggedTestId}"]`);
      const target = document.querySelector(`[data-testid="${targetTestId}"]`);
      if (!source || !target) {
        throw new Error(
          `drag source or target not found: ${draggedTestId} / ${targetTestId}`,
        );
      }
      const fire = (el: Element, type: string) =>
        el.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }),
        );
      fire(source, "dragstart");
      fire(target, "dragenter");
      fire(target, "dragover");
      fire(target, "drop");
      fire(source, "dragend");
    },
    { draggedTestId: `overlay-row-${draggedId}`, targetTestId: `overlay-row-${targetId}` },
  );
}
