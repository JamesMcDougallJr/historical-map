import type { Page } from "@playwright/test";

/**
 * The admin app's delete flows use native `confirm()`
 * (apps/admin/app/locations/[id]/page.tsx, apps/admin/app/sequences/[id]/page.tsx).
 * Playwright auto-dismisses dialogs unless a listener is registered, so tests
 * that want to accept or dismiss explicitly must register one first.
 *
 * `page.once`, not `page.on`: a test exercising both outcomes calls this
 * twice in a row (dismiss for the cancel path, then accept for the real
 * delete), and `page.on` listeners stack rather than replace — the first
 * (dismiss) one stays registered and races the second (accept) one for the
 * next dialog, throwing "Cannot accept dialog which is already handled!"
 * whenever dismiss wins the race.
 */
export function autoAcceptConfirm(page: Page): void {
  page.once("dialog", (dialog) => void dialog.accept());
}

export function autoDismissConfirm(page: Page): void {
  page.once("dialog", (dialog) => void dialog.dismiss());
}
