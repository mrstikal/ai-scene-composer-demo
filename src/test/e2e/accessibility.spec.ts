import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function createProject(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.post("/api/projects", { data: { title } });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { projectId: string }).projectId;
}

async function importSample(request: APIRequestContext, projectId: string): Promise<void> {
  const response = await request.post(`/api/projects/${projectId}/sample`, {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: { sampleId: "living-room-v1" },
  });
  expect(response.status()).toBe(201);
}

async function openProject(page: Page, projectId: string): Promise<void> {
  await page.goto(`/?project=${projectId}`);
  await expect(page.getByAltText("Active canonical scene")).toBeVisible({ timeout: 30000 });
}

test.describe("mobile layout and basic accessibility", () => {
  test("keeps the mock editor labelled and free of horizontal overflow at 390 px", async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const projectId = await createProject(request, "Mobile Accessibility");
    await page.goto(`/?project=${projectId}`);
    await expect(page.getByRole("heading", { name: "AI Scene Composer" })).toBeVisible();

    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByLabel("Existing project")).toBeVisible();
    await expect(page.getByLabel("New project title")).toBeVisible();
    await expect(page.getByRole("button", { name: "New Scene", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Use Bundled Sample", exact: true })).toBeVisible();

    await expect(page.getByRole("button", { name: "Sample", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("button", { name: "Upload", exact: true })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await importSample(request, projectId);
    await openProject(page, projectId);

    await expect(page.getByLabel("Target label")).toBeVisible();
    await expect(page.getByLabel("Edit instruction")).toBeVisible();
    await expect(page.getByLabel("Model")).toBeVisible();
    await expect(page.getByRole("button", { name: "Padding 16 px" })).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    const imagesWithoutAlt = await page.locator("img:not([alt])").count();
    expect(imagesWithoutAlt).toBe(0);

    const unnamedButtons = await page.locator("button").evaluateAll(
      (buttons) =>
        buttons.filter((button) => {
          const text = button.textContent?.trim() ?? "";
          return (
            text.length === 0 &&
            (button.getAttribute("aria-label") ?? "").length === 0 &&
            (button.getAttribute("title") ?? "").length === 0
          );
        }).length,
    );
    expect(unnamedButtons).toBe(0);
  });
});
