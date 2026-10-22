import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function createProject(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.post("/api/projects", { data: { title } });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { projectId: string };
  return body.projectId;
}

async function importSample(
  request: APIRequestContext,
  projectId: string,
): Promise<{ rootVersionId: string }> {
  const response = await request.post(`/api/projects/${projectId}/sample`, {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: { sampleId: "living-room-v1" },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { rootVersionId: string };
}

async function openProject(page: Page, projectId: string): Promise<void> {
  await page.goto(`/?project=${projectId}`);
  await expect(page.getByAltText("Active canonical scene")).toBeVisible({ timeout: 30000 });
}

async function snapshot(request: APIRequestContext, projectId: string) {
  const response = await request.get(`/api/projects/${projectId}`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    project: { activeVersionId: string | null };
    selections: Array<{
      id: string;
      sourceVersionId: string;
      positivePoints: Array<{ x: number; y: number }>;
      negativePoints: Array<{ x: number; y: number }>;
      binaryMaskAssetId: string;
      regions: {
        variants: Record<
          "16" | "32",
          { allowedMaskAssetId: string; blendMaskAssetId: string }
        >;
      };
    }>;
    runs: Array<{ id: string; kind: string; status: string; outputSelectionId: string | null }>;
  };
}

async function clickAtFraction(
  page: Page,
  fractionX: number,
  fractionY: number,
): Promise<void> {
  const image = page.getByAltText("Active canonical scene");
  await image.scrollIntoViewIfNeeded();
  const box = await image.boundingBox();
  if (box === null) throw new Error("Scene image has no bounding box.");
  const size = Math.min(box.width, box.height);
  const left = box.x + (box.width - size) / 2;
  const top = box.y + (box.height - size) / 2;
  await page.mouse.click(left + size * fractionX, top + size * fractionY);
}

async function waitForSelections(
  request: APIRequestContext,
  projectId: string,
  count: number,
) {
  await expect
    .poll(async () => (await snapshot(request, projectId)).selections.length, {
      timeout: 30000,
    })
    .toBe(count);
  return snapshot(request, projectId);
}

test.describe("mock SAM selection", () => {
  test("places aligned points at desktop and mobile display sizes", async ({ page, request }) => {
    const projectId = await createProject(request, "E2E Selection Alignment");
    const sample = await importSample(request, projectId);

    await page.setViewportSize({ width: 1440, height: 900 });
    await openProject(page, projectId);
    const sceneImage = page.getByAltText("Active canonical scene");
    const sceneSrc = await sceneImage.getAttribute("src");
    expect(sceneSrc).not.toBeNull();
    await expect(
      page.getByRole("link", { name: "Open scene full resolution" }),
    ).toHaveAttribute("href", sceneSrc as string);
    await clickAtFraction(page, 0.25, 0.75);
    await waitForSelections(request, projectId, 1);
    await expect(page.getByText(/Selection [0-9a-f]{8}/)).toBeVisible();

    const desktop = await snapshot(request, projectId);
    expect(desktop.selections[0]?.sourceVersionId).toBe(sample.rootVersionId);
    expect(desktop.selections[0]?.positivePoints[0]?.x).toBeGreaterThanOrEqual(254);
    expect(desktop.selections[0]?.positivePoints[0]?.x).toBeLessThanOrEqual(258);
    expect(desktop.selections[0]?.positivePoints[0]?.y).toBeGreaterThanOrEqual(766);
    expect(desktop.selections[0]?.positivePoints[0]?.y).toBeLessThanOrEqual(770);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByAltText("Active canonical scene")).toBeVisible();
    await clickAtFraction(page, 0.25, 0.75);
    const mobile = await waitForSelections(request, projectId, 2);
    expect(mobile.selections[1]?.positivePoints[0]?.x).toBeGreaterThanOrEqual(254);
    expect(mobile.selections[1]?.positivePoints[0]?.x).toBeLessThanOrEqual(258);
    expect(mobile.selections[1]?.positivePoints[0]?.y).toBeGreaterThanOrEqual(766);
    expect(mobile.selections[1]?.positivePoints[0]?.y).toBeLessThanOrEqual(770);
  });

  test("switches padding and overlay controls without a new SAM call", async ({ page, request }) => {
    const projectId = await createProject(request, "E2E Selection Padding");
    await importSample(request, projectId);
    await openProject(page, projectId);

    await clickAtFraction(page, 0.5, 0.6);
    const selected = await waitForSelections(request, projectId, 1);
    const selection = selected.selections[0];
    if (selection === undefined) throw new Error("Selection is missing.");

    const maskOverlay = page.locator('[data-overlay="object-mask"]');
    const allowedOverlay = page.locator('[data-overlay="allowed-region"]');
    await expect(maskOverlay).toBeVisible();
    await expect(allowedOverlay).toBeVisible();

    await page.getByLabel("Show SAM mask").uncheck();
    await expect(maskOverlay).toHaveCount(0);
    await page.getByLabel("Show SAM mask").check();
    await expect(maskOverlay).toBeVisible();

    const slider = page.getByLabel("Mask opacity");
    await slider.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByText("0.40", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Padding 32 px" }).click();
    await expect(
      page.getByRole("link", { name: "View allowed region" }),
    ).toHaveAttribute("href", `/api/assets/${selection.regions.variants["32"].allowedMaskAssetId}`);

    await page.waitForTimeout(1000);
    const after = await snapshot(request, projectId);
    expect(after.selections).toHaveLength(1);
    expect(after.runs.filter((run) => run.kind === "segment")).toHaveLength(1);

    await page.reload();
    await expect(page.getByText(/Selection [0-9a-f]{8}/)).toBeVisible();
    await expect(page.locator('[data-overlay="object-mask"]')).toBeVisible();
  });

  test("adds a negative correction as a new immutable selection", async ({ page, request }) => {
    const projectId = await createProject(request, "E2E Selection Negative");
    await importSample(request, projectId);
    await openProject(page, projectId);

    await clickAtFraction(page, 0.5, 0.6);
    const first = await waitForSelections(request, projectId, 1);
    const firstSelection = first.selections[0];
    if (firstSelection === undefined) throw new Error("First selection is missing.");

    await page.getByRole("button", { name: "Negative point" }).click();
    await clickAtFraction(page, 0.4, 0.4);
    const second = await waitForSelections(request, projectId, 2);
    const corrected = second.selections[1];
    if (corrected === undefined) throw new Error("Corrected selection is missing.");

    expect(second.selections[0]).toEqual(firstSelection);
    expect(corrected.positivePoints).toEqual(firstSelection.positivePoints);
    expect(corrected.negativePoints).toHaveLength(1);
    expect(corrected.binaryMaskAssetId).not.toBe(firstSelection.binaryMaskAssetId);
    await expect(page.getByText(/− \(\d+, \d+\)/)).toBeVisible();

    await page.getByLabel("Saved selection").selectOption(firstSelection.id);
    await expect(
      page.getByText(`Selection ${firstSelection.id.slice(0, 8)}`, { exact: true }),
    ).toBeVisible();
    await clickAtFraction(page, 0.6, 0.5);
    const third = await waitForSelections(request, projectId, 3);
    expect(third.selections[2]?.positivePoints).toHaveLength(1);
  });

  test("adds positive and negative points with Photoshop-style modifiers", async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, "E2E Selection Modifiers");
    await importSample(request, projectId);
    await openProject(page, projectId);

    await clickAtFraction(page, 0.5, 0.6);
    const first = await waitForSelections(request, projectId, 1);
    const firstSelection = first.selections[0];
    if (firstSelection === undefined) throw new Error("First selection is missing.");
    await expect(
      page.getByText(`Selection ${firstSelection.id.slice(0, 8)}`, { exact: true }),
    ).toBeVisible({ timeout: 30000 });

    await page.keyboard.down("Shift");
    await clickAtFraction(page, 0.6, 0.6);
    await page.keyboard.up("Shift");
    const second = await waitForSelections(request, projectId, 2);
    const secondSelection = second.selections[1];
    if (secondSelection === undefined) throw new Error("Second selection is missing.");
    await expect(
      page.getByText(`Selection ${secondSelection.id.slice(0, 8)}`, { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    expect(second.selections[1]?.positivePoints).toHaveLength(2);
    expect(second.selections[1]?.negativePoints).toHaveLength(0);
    expect(second.selections[0]).toEqual(firstSelection);
    await expect(page.getByText(/\+ \(\d+, \d+\)/)).toHaveCount(2);

    await page.keyboard.down("Alt");
    await clickAtFraction(page, 0.4, 0.4);
    await page.keyboard.up("Alt");
    const third = await waitForSelections(request, projectId, 3);
    expect(third.selections[2]?.positivePoints).toHaveLength(2);
    expect(third.selections[2]?.negativePoints).toHaveLength(1);
    expect(third.selections[2]?.positivePoints).toEqual(
      second.selections[1]?.positivePoints,
    );
    await expect(page.getByText(/− \(\d+, \d+\)/)).toHaveCount(1);
  });

  test("shows an error flash that stays until dismissed", async ({ page, request }) => {
    const projectId = await createProject(request, "E2E Feedback");
    await importSample(request, projectId);
    await openProject(page, projectId);

    await page.keyboard.down("Alt");
    await clickAtFraction(page, 0.3, 0.3);
    await page.keyboard.up("Alt");

    const flash = page
      .getByRole("alert")
      .filter({ hasText: "Place at least one positive point before subtracting." });
    await expect(flash).toBeVisible();
    await page.waitForTimeout(3500);
    await expect(flash).toBeVisible();
    await flash.getByRole("button", { name: "Dismiss notification" }).click();
    await expect(flash).toBeHidden();
  });

});
