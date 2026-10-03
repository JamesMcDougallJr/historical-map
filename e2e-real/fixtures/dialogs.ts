import type { Page } from "@playwright/test";

/**
 * The admin app's delete flows use native `confirm()`
 * (apps/admin/app/locations/[id]/page.tsx, apps/admin/app/sequences/[id]/page.tsx).
 * Playwright auto-dismisses dialogs unless a listener is registered, so tests
 * that want to accept or dismiss explicitly must register one first.
 */
export function autoAcceptConfirm(page: Page): void {
  page.on("dialog", (dialog) => void dialog.accept());
}

export function autoDismissConfirm(page: Page): void {
  page.on("dialog", (dialog) => void dialog.dismiss());
}
