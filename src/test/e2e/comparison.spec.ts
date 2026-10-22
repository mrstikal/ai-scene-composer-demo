import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function createProject(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.post("/api/projects", { data: { title } });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { projectId: string }).projectId;
}

async function importSample(request: APIRequestContext, projectId: string): Promise<string> {
  const response = await request.post(`/api/projects/${projectId}/sample`, {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: { sampleId: "living-room-v1" },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { rootVersionId: string }).rootVersionId;
}

async function openProject(page: Page, projectId: string): Promise<void> {
  await page.goto(`/?project=${projectId}`);
  await expect(page.getByAltText("Active canonical scene")).toBeVisible({ timeout: 30000 });
}

async function clickAtFraction(page: Page, fractionX: number, fractionY: number): Promise<void> {
  const image = page.getByAltText("Active canonical scene");
  await image.scrollIntoViewIfNeeded();
  const box = await image.boundingBox();
  if (box === null) throw new Error("Scene image has no bounding box.");
  const size = Math.min(box.width, box.height);
  const left = box.x + (box.width - size) / 2;
  const top = box.y + (box.height - size) / 2;
  await page.mouse.click(left + size * fractionX, top + size * fractionY);
}

interface Snapshot {
  project: { rootVersionId: string | null; activeVersionId: string | null };
  runs: Array<{
    id: string;
    kind: string;
    model: string;
    status: string;
    comparisonGroupId: string | null;
    retryOfRunId: string | null;
    commonInputHash: string | null;
    parentVersionId: string | null;
    outputVersionId: string | null;
    editInput: { scope: "selection" | "scene"; selectionId: string | null } | null;
    evaluation: {
      boundaryArtifacts: number;
      promptAdherence: number;
      referenceFidelity: number | null;
      plausibility: number;
      notes: string;
    } | null;
  }>;
  selections: Array<{ id: string; sourceVersionId: string }>;
}

async function snapshot(request: APIRequestContext, projectId: string): Promise<Snapshot> {
  const response = await request.get(`/api/projects/${projectId}`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Snapshot;
}

async function waitForSelections(
  request: APIRequestContext,
  projectId: string,
  count: number,
): Promise<Snapshot> {
  await expect
    .poll(async () => (await snapshot(request, projectId)).selections.length, { timeout: 30000 })
    .toBe(count);
  return snapshot(request, projectId);
}

test.describe("mock comparison and evaluation", () => {
  test("runs Sunburst singly, compares both models side by side, saves evaluation and rehydrates after reload", async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, "E2E Comparison");
    const rootVersionId = await importSample(request, projectId);
    await openProject(page, projectId);

    await clickAtFraction(page, 0.5, 0.6);
    await waitForSelections(request, projectId, 1);

    await page.getByLabel("Edit instruction").fill("Make the sofa green.");
    await page.getByLabel("Model").selectOption("openai/gpt-image-2.5-sunburst");
    await page.getByLabel(/I confirm the estimated cost/).check();
    await page.getByRole("button", { name: "Run Edit" }).click();
    await expect(page.getByRole("button", { name: "Continue from This Result" })).toBeVisible({
      timeout: 60000,
    });

    let current = await snapshot(request, projectId);
    const single = current.runs.find((run) => run.kind === "edit");
    expect(single).toMatchObject({
      model: "openai/gpt-image-2.5-sunburst",
      status: "succeeded",
      comparisonGroupId: null,
      parentVersionId: rootVersionId,
    });

    await page.getByLabel("Edit instruction").fill("Make the sofa green.");
    await page.getByLabel(/I confirm the estimated cost/).check();
    await page.getByRole("button", { name: "Compare Both" }).click();
    await expect(page.getByText("Frozen input identical")).toBeVisible({ timeout: 60000 });
    await expect(page.getByText("Shared mask (SAM):")).toBeVisible();

    await expect
      .poll(
        async () =>
          (await snapshot(request, projectId)).runs.filter(
            (run) => run.comparisonGroupId !== null && run.status === "succeeded",
          ).length,
        { timeout: 60000 },
      )
      .toBe(2);
    current = await snapshot(request, projectId);
    const groupRuns = current.runs.filter((run) => run.comparisonGroupId !== null);
    expect(groupRuns).toHaveLength(2);
    expect(groupRuns.map((run) => run.model).sort()).toEqual([
      "openai/gpt-image-2.5-flare",
      "openai/gpt-image-2.5-sunburst",
    ]);
    expect(new Set(groupRuns.map((run) => run.commonInputHash)).size).toBe(1);
    expect(groupRuns.every((run) => run.parentVersionId === rootVersionId)).toBe(true);

    const comparison = page.locator("section").filter({ hasText: "Frozen input identical" });
    await expect(
      comparison.getByRole("link", { name: "Open Flare final image full resolution" }),
    ).toBeVisible();
    await comparison.getByRole("button", { name: "Raw" }).first().click();
    await expect(
      comparison.getByRole("link", { name: "Open Flare raw image full resolution" }),
    ).toBeVisible();
    await comparison.getByRole("button", { name: "Final" }).first().click();
    await expect(comparison.getByText("Attempt history (2)")).toBeVisible();
    await expect(comparison.getByRole("button", { name: "Continue from Flare" })).toBeVisible();
    await expect(comparison.getByRole("button", { name: "Continue from Sunburst" })).toBeVisible();

    await comparison.getByLabel("Boundary artifacts").first().selectOption("4");
    await comparison.getByLabel("Prompt adherence").first().selectOption("5");
    await comparison.getByLabel("Plausibility").first().selectOption("3");
    await comparison.getByLabel("Notes").first().fill("Flare keeps the sofa geometry.");
    await comparison.getByRole("button", { name: "Save Evaluation" }).first().click();
    await expect(page.getByText("Evaluation saved.")).toBeVisible({ timeout: 30000 });

    const flare = groupRuns.find((run) => run.model.includes("flare"));
    if (flare === undefined) throw new Error("Flare run is missing.");
    await expect
      .poll(
        async () =>
          (await snapshot(request, projectId)).runs.find((run) => run.id === flare.id)?.evaluation,
        { timeout: 30000 },
      )
      .toEqual({
        boundaryArtifacts: 4,
        promptAdherence: 5,
        referenceFidelity: null,
        plausibility: 3,
        notes: "Flare keeps the sofa geometry.",
      });

    await page.reload();
    await expect(page.getByAltText("Active canonical scene")).toBeVisible({ timeout: 30000 });
    await expect(page.getByText("Frozen input identical")).toBeVisible({ timeout: 30000 });
    const reloadedComparison = page
      .locator("section")
      .filter({ hasText: "Frozen input identical" });
    await expect(reloadedComparison.getByLabel("Boundary artifacts").first()).toHaveValue("4");
    await expect(reloadedComparison.getByLabel("Prompt adherence").first()).toHaveValue("5");
    await expect(reloadedComparison.getByLabel("Plausibility").first()).toHaveValue("3");

    await reloadedComparison.getByRole("button", { name: "Continue from Flare" }).click();
    await expect
      .poll(async () => (await snapshot(request, projectId)).project.activeVersionId, {
        timeout: 30000,
      })
      .toBe(flare.outputVersionId);

    await expect(page.getByRole("heading", { name: "Costs" })).toBeVisible();
    await expect(page.getByText("Commitment")).toBeVisible();
  });

  test("compares both models for a whole-scene instruction without a selection", async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, "E2E Scene Comparison");
    await importSample(request, projectId);
    await openProject(page, projectId);

    await page.getByRole("button", { name: "Whole scene" }).click();
    await page.getByLabel("Scene instruction").fill("Change the lighting to night.");
    await page.getByLabel(/I confirm the estimated cost/).check();
    await page.getByRole("button", { name: "Compare Both" }).click();

    await expect(page.getByText("Frozen input identical")).toBeVisible({ timeout: 60000 });
    await expect(
      page.getByText("Whole-scene comparison: no SAM mask is shared or charged."),
    ).toBeVisible();

    await expect
      .poll(
        async () =>
          (await snapshot(request, projectId)).runs.filter(
            (run) => run.comparisonGroupId !== null && run.status === "succeeded",
          ).length,
        { timeout: 60000 },
      )
      .toBe(2);
    const current = await snapshot(request, projectId);
    const groupRuns = current.runs.filter((run) => run.comparisonGroupId !== null);
    expect(groupRuns).toHaveLength(2);
    expect(groupRuns.every((run) => run.editInput?.scope === "scene")).toBe(true);
    expect(groupRuns.every((run) => run.editInput?.selectionId === null)).toBe(true);
    expect(current.selections).toHaveLength(0);
  });

});
