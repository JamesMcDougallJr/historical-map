import { test, expect } from "@playwright/test";
import { autoAcceptConfirm, autoDismissConfirm } from "../../fixtures/dialogs";
import { FX_GROUP, FX_LOCATIONS } from "../../fixtures/seed-data";

test.describe("admin: sequences CRUD (real backend)", () => {
  test("title and description edits persist", async ({ page }) => {
    await page.goto(`/sequences/${FX_GROUP.id}`);

    await expect(page.getByTestId("sequence-title-input")).toHaveValue(
      FX_GROUP.title,
    );

    await page.getByTestId("sequence-title-input").fill("Fixture Sequence Renamed");
    await page.getByTestId("sequence-save-details-button").click();

    await page.reload();
    await expect(page.getByTestId("sequence-title-input")).toHaveValue(
      "Fixture Sequence Renamed",
    );

    // Restore for other tests in this shared-DB suite.
    await page.getByTestId("sequence-title-input").fill(FX_GROUP.title);
    await page.getByTestId("sequence-save-details-button").click();
  });

  test("members: up/down reorder, add via search, remove", async ({
    page,
  }) => {
    await page.goto(`/sequences/${FX_GROUP.id}`);

    const members = () => page.locator('[data-testid^="sequence-member-row-"]');
    await expect(members()).toHaveCount(FX_GROUP.memberEventIds.length);

    const firstMemberId = (await members().nth(0).getAttribute("data-testid"))!
      .replace("sequence-member-row-", "");
    const secondMemberId = (await members().nth(1).getAttribute("data-testid"))!
      .replace("sequence-member-row-", "");

    // Move the first member down; it should now be second.
    await page.getByTestId(`sequence-member-down-${firstMemberId}`).click();
    await expect(members().nth(0)).toHaveAttribute(
      "data-testid",
      `sequence-member-row-${secondMemberId}`,
    );
    // Move it back up to restore original order.
    await page.getByTestId(`sequence-member-up-${firstMemberId}`).click();
    await expect(members().nth(0)).toHaveAttribute(
      "data-testid",
      `sequence-member-row-${firstMemberId}`,
    );

    // Add a third member via search, then remove it again.
    const newMemberEvent = FX_LOCATIONS[2]!.events[0]!;
    await page.getByTestId("sequence-add-member-search-input").fill(
      newMemberEvent.title,
    );
    await page.getByTestId("sequence-add-member-search-button").click();
    await page
      .getByTestId(`sequence-add-member-button-${newMemberEvent.id}`)
      .click();
    await expect(members()).toHaveCount(FX_GROUP.memberEventIds.length + 1);

    await page
      .getByTestId(`sequence-member-remove-${newMemberEvent.id}`)
      .click();
    await expect(members()).toHaveCount(FX_GROUP.memberEventIds.length);
  });

  test("delete sequence: cancel keeps it, accept removes it", async ({
    page,
    request,
  }) => {
    // Exercised against a disposable sequence, not FX_GROUP — deleting that
    // one would break every other spec in this shared-DB suite. Posted
    // directly to the web app's API (not the admin project's own baseURL,
    // which is a different origin) with the same key the webServer env sets.
    const createRes = await request.post(
      "http://localhost:3000/api/data/groups",
      {
        headers: { "x-api-key": "test-api-key" },
        data: { id: "fx-group-disposable", title: "Disposable Sequence" },
      },
    );
    expect(createRes.ok()).toBeTruthy();

    await page.goto("/sequences/fx-group-disposable");

    autoDismissConfirm(page);
    await page.getByTestId("sequence-delete-button").click();
    await expect(page.getByTestId("sequence-title-input")).toBeVisible();

    autoAcceptConfirm(page);
    await page.getByTestId("sequence-delete-button").click();
    await expect(page).toHaveURL(/\/sequences$/);
  });
});
