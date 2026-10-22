import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const PRESETS = [
  { label: "Cozy Living Room", id: "cozy-living-room" },
  { label: "Scandinavian Dining Room", id: "scandinavian-dining-room" },
  { label: "Minimalist Bedroom", id: "minimalist-bedroom" },
] as const;

async function createProject(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.post("/api/projects", { data: { title } });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { projectId: string };
  return body.projectId;
}

async function openProject(page: Page, projectId: string): Promise<void> {
  await page.goto(`/?project=${projectId}`);
  const generateTab = page.getByRole("button", { name: "Generate", exact: true });
  await expect(generateTab).toBeVisible();
  await generateTab.click();
  await expect(page.getByRole("button", { name: "Custom Prompt", exact: true })).toBeVisible();
}

async function acceptGeneration(page: Page): Promise<void> {
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Generate Scene", exact: true }).click();
}

async function expectRoot(page: Page, request: APIRequestContext, projectId: string): Promise<void> {
  await expect(page.getByAltText("Active canonical scene")).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole("button", { name: /generate .*root/ })).toBeVisible();

  const response = await request.get(`/api/projects/${projectId}`);
  expect(response.ok()).toBeTruthy();
  const snapshot = (await response.json()) as {
    project: { rootVersionId: string | null };
    versions: Array<{ origin: string }>;
    runs: Array<{ status: string; kind: string }>;
  };
  expect(snapshot.project.rootVersionId).not.toBeNull();
  expect(snapshot.versions).toHaveLength(1);
  expect(snapshot.versions[0]?.origin).toBe("generate");
  expect(snapshot.runs.find((run) => run.kind === "generate")?.status).toBe("succeeded");
}

test.describe("mock generation", () => {
  for (const preset of PRESETS) {
    test(`generates the ${preset.label} preset`, async ({ page, request }) => {
      const projectId = await createProject(request, `E2E ${preset.label}`);
      await openProject(page, projectId);

      await page.getByRole("button", { name: new RegExp(preset.label) }).click();
      await acceptGeneration(page);
      await expectRoot(page, request, projectId);
    });
  }

  test("generates a custom prompt and reloads the persisted root", async ({ page, request }) => {
    const projectId = await createProject(request, "E2E Custom");
    await openProject(page, projectId);

    await page.getByRole("button", { name: "Custom Prompt", exact: true }).click();
    await page.getByLabel("Custom prompt").fill(
      "A photorealistic sunlit study with a blue armchair and a wooden desk, no people.",
    );
    await acceptGeneration(page);
    await expectRoot(page, request, projectId);

    await page.reload();
    await expect(page.getByAltText("Active canonical scene")).toBeVisible();
    await expect(page.getByRole("button", { name: /generate .*root/ })).toBeVisible();
  });
});
