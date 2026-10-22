import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function createProject(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.post("/api/projects", { data: { title } });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { projectId: string }).projectId;
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

interface Snapshot {
  project: { rootVersionId: string | null; activeVersionId: string | null };
  versions: Array<{
    id: string;
    parentVersionId: string | null;
    imageAssetId: string;
    origin: string;
    sourceMetadata: unknown;
  }>;
  selections: Array<{ id: string; sourceVersionId: string }>;
  references: Array<{ id: string; createdAt: number }>;
  runs: Array<{
    id: string;
    kind: string;
    status: string;
    stage: string;
    parentVersionId: string | null;
    outputVersionId: string | null;
    rawAssetId: string | null;
    normalizedRawAssetId: string | null;
    editInput: {
      parentVersionId: string;
      selectionId: string;
      paddingPx: number;
      targetLabel: string;
      instruction: string;
      referenceAssetIds: string[];
      model: string;
    } | null;
    metrics: {
      protectedPixelCount: number;
      rawBackgroundMae: number | null;
      finalBackgroundMae: number | null;
      protectedMismatchPixels: number;
      nativeWidth?: number;
      nativeHeight?: number;
      normalizedWidth?: number;
      normalizedHeight?: number;
    } | null;
    cost: {
      amountUsdMicros: number | null;
      provenance: string | null;
      outcome: string | null;
    };
    errorMessage: string | null;
    retryMode: string;
    retryReservationUsdMicros: number;
  }>;
}

async function snapshot(request: APIRequestContext, projectId: string): Promise<Snapshot> {
  const response = await request.get(`/api/projects/${projectId}`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Snapshot;
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

async function waitForSelections(
  request: APIRequestContext,
  projectId: string,
  count: number,
): Promise<Snapshot> {
  await expect
    .poll(async () => (await snapshot(request, projectId)).selections.length, {
      timeout: 30000,
    })
    .toBe(count);
  return snapshot(request, projectId);
}

async function waitForEdits(
  request: APIRequestContext,
  projectId: string,
  count: number,
): Promise<Snapshot> {
  await expect
    .poll(
      async () =>
        (await snapshot(request, projectId)).runs.filter(
          (run) =>
            run.kind === "edit" &&
            (run.status === "succeeded" ||
              run.status === "failed" ||
              run.status === "needs_review"),
        ).length,
      { timeout: 60000 },
    )
    .toBe(count);
  return snapshot(request, projectId);
}

async function selectObject(page: Page, request: APIRequestContext, projectId: string): Promise<Snapshot> {
  const before = (await snapshot(request, projectId)).selections.length;
  await clickAtFraction(page, 0.5, 0.6);
  return waitForSelections(request, projectId, before + 1);
}

async function fillAndRunEdit(page: Page, instruction: string): Promise<void> {
  await page.getByLabel("Edit instruction").fill(instruction);
  await page.getByLabel(/I confirm the estimated edit cost/).check();
  const run = page.getByRole("button", { name: "Run Edit" });
  await expect(run).toBeEnabled();
  await run.click();
}

test.describe("mock single-model editing", () => {
  test("creates a child, shows raw/final, preserves protected pixels and continues", async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, "E2E Edit Success");
    const sample = await importSample(request, projectId);
    await openProject(page, projectId);
    await selectObject(page, request, projectId);

    await fillAndRunEdit(page, "Make the sofa green.");
    await expect(page.getByRole("button", { name: "Continue from This Result" })).toBeVisible({
      timeout: 60000,
    });

    const edited = await waitForEdits(request, projectId, 1);
    const run = edited.runs.find((candidate) => candidate.kind === "edit");
    if (run === undefined) throw new Error("Edit run is missing.");
    expect(run).toMatchObject({
      status: "succeeded",
      parentVersionId: sample.rootVersionId,
      cost: { amountUsdMicros: 0, provenance: "calculated", outcome: "completed" },
    });
    expect(edited.project.activeVersionId).toBe(sample.rootVersionId);
    expect(run.metrics?.finalBackgroundMae).toBe(0);
    expect(run.metrics?.protectedMismatchPixels).toBe(0);
    expect(run.metrics?.protectedPixelCount).toBeGreaterThan(0);
    const child = edited.versions.find((version) => version.id === run.outputVersionId);
    expect(child).toMatchObject({
      parentVersionId: sample.rootVersionId,
      origin: "edit",
    });

    await page.getByRole("button", { name: "Raw" }).click();
    await expect(page.getByAltText("Raw provider output")).toBeVisible();
    await page.getByRole("button", { name: "Final" }).click();
    await expect(page.getByAltText("Final edit result")).toBeVisible();
    await expect(page.getByLabel("Before / After")).toBeVisible();

    const slider = page.getByLabel("Before / After");
    await slider.focus();
    await page.keyboard.press("ArrowRight");
    await expect(slider).toHaveValue("51");

    await page.getByRole("button", { name: "Continue from This Result" }).click();
    await expect
      .poll(async () => (await snapshot(request, projectId)).project.activeVersionId, {
        timeout: 30000,
      })
      .toBe(child?.id);
    await expect(page.getByAltText("Active canonical scene")).toBeVisible();
  });

  test("uploads, orders and submits two references in the displayed order", async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, "E2E Edit References");
    await importSample(request, projectId);
    await openProject(page, projectId);
    await selectObject(page, request, projectId);

    const fileInput = page.getByLabel("Reference image file");
    await fileInput.setInputFiles("src/test/fixtures/synthetic/reference-sofa-v1.png");
    await page.getByRole("button", { name: "Upload reference" }).click();
    await expect(page.getByText("Image 2", { exact: true })).toBeVisible({ timeout: 30000 });

    await fileInput.setInputFiles("src/test/fixtures/synthetic/reference-sofa-v1.png");
    await page.getByRole("button", { name: "Upload reference" }).click();
    await expect(page.getByText("Image 3", { exact: true })).toBeVisible({ timeout: 30000 });

    await page.getByRole("button", { name: "Move Image 3 left" }).click();
    await fillAndRunEdit(page, "Use the reference.");
    await expect(page.getByRole("button", { name: "Continue from This Result" })).toBeVisible({
      timeout: 60000,
    });

    const edited = await waitForEdits(request, projectId, 1);
    const run = edited.runs.find((candidate) => candidate.kind === "edit");
    if (run === undefined || run.editInput === null) throw new Error("Edit input is missing.");
    expect(edited.references).toHaveLength(2);
    const ordered = [...edited.references].sort((left, right) => left.createdAt - right.createdAt);
    expect(run.editInput.referenceAssetIds).toEqual([ordered[1]?.id, ordered[0]?.id]);
    const child = edited.versions.find((version) => version.id === run.outputVersionId);
    expect(child?.sourceMetadata).toMatchObject({
      kind: "edit",
      referenceAssetIds: [ordered[1]?.id, ordered[0]?.id],
    });
  });

  test("branches from the root and from a completed child, with Continue as the only pointer switch", async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, "E2E Edit Branches");
    const sample = await importSample(request, projectId);
    await openProject(page, projectId);
    await selectObject(page, request, projectId);

    await fillAndRunEdit(page, "First branch.");
    await expect(page.getByRole("button", { name: "Continue from This Result" })).toBeVisible({
      timeout: 60000,
    });
    let edited = await waitForEdits(request, projectId, 1);
    const first = edited.runs.find((candidate) => candidate.kind === "edit");
    if (first?.outputVersionId === null || first?.outputVersionId === undefined) {
      throw new Error("First child is missing.");
    }
    expect(edited.project.activeVersionId).toBe(sample.rootVersionId);

    await page.getByRole("button", { name: "Continue from This Result" }).click();
    await expect
      .poll(async () => (await snapshot(request, projectId)).project.activeVersionId, {
        timeout: 30000,
      })
      .toBe(first.outputVersionId);
    await selectObject(page, request, projectId);

    await fillAndRunEdit(page, "Second branch from the child.");
    await expect(page.getByRole("button", { name: "Continue from This Result" })).toBeVisible({
      timeout: 60000,
    });
    edited = await waitForEdits(request, projectId, 2);
    const second = edited.runs.filter((candidate) => candidate.kind === "edit")[1];
    if (second?.outputVersionId === null || second?.outputVersionId === undefined) {
      throw new Error("Second child is missing.");
    }
    const grandchild = edited.versions.find((version) => version.id === second.outputVersionId);
    expect(grandchild?.parentVersionId).toBe(first.outputVersionId);
    expect(edited.project.activeVersionId).toBe(first.outputVersionId);

    await page
      .getByRole("button", { name: new RegExp(`sample ${sample.rootVersionId.slice(0, 8)}`) })
      .click();
    await expect
      .poll(async () => (await snapshot(request, projectId)).project.activeVersionId, {
        timeout: 30000,
      })
      .toBe(sample.rootVersionId);

    await fillAndRunEdit(page, "Third branch from the root.");
    await expect(page.getByRole("button", { name: "Continue from This Result" })).toBeVisible({
      timeout: 60000,
    });
    edited = await waitForEdits(request, projectId, 3);
    const third = edited.runs.filter((candidate) => candidate.kind === "edit")[2];
    if (third?.outputVersionId === null || third?.outputVersionId === undefined) {
      throw new Error("Third child is missing.");
    }
    const thirdChild = edited.versions.find((version) => version.id === third.outputVersionId);
    expect(thirdChild?.parentVersionId).toBe(sample.rootVersionId);
    expect(edited.project.activeVersionId).toBe(sample.rootVersionId);
  });
});
