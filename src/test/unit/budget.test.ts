import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertReservationAllowed,
  getProjectCommitmentMicros,
  releasePreProviderReservation,
  setRunBudgetCharge,
} from "@/lib/budget/service";
import { projects } from "@/lib/db/schema";
import { createProject } from "@/lib/projects/service";
import { createTestEnvironment, type TestEnvironment } from "@/test/helpers/environment";
import { insertRun } from "@/test/helpers/domain";

let testEnv: TestEnvironment;

beforeEach(async () => {
  testEnv = await createTestEnvironment();
});

afterEach(async () => {
  await testEnv.cleanup();
});

describe("integer budget reservations", () => {
  it("sums run budget charges and enforces the project cap", () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Budget");
    testEnv.handle.db
      .update(projects)
      .set({ budgetLimitUsdMicros: 1000 })
      .where(eq(projects.id, project.id))
      .run();

    const first = insertRun(testEnv.handle.db, project.id, { budgetChargeUsdMicros: 600 });
    expect(getProjectCommitmentMicros(testEnv.handle.db, project.id)).toBe(600);

    expect(() => assertReservationAllowed(testEnv.handle.db, project.id, 500)).toThrow(
      "The project budget would be exceeded.",
    );
    expect(assertReservationAllowed(testEnv.handle.db, project.id, 400)).toEqual({
      commitmentUsdMicros: 600,
      budgetLimitUsdMicros: 1000,
    });

    setRunBudgetCharge(testEnv.handle.db, first.id, 250);
    expect(getProjectCommitmentMicros(testEnv.handle.db, project.id)).toBe(250);

    releasePreProviderReservation(testEnv.handle.db, first.id);
    expect(getProjectCommitmentMicros(testEnv.handle.db, project.id)).toBe(0);
  });

  it("allows zero-cost mock and fixture reservations even after an overrun", () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Zero");
    testEnv.handle.db
      .update(projects)
      .set({ budgetLimitUsdMicros: 1000 })
      .where(eq(projects.id, project.id))
      .run();
    insertRun(testEnv.handle.db, project.id, { budgetChargeUsdMicros: 1500 });

    expect(assertReservationAllowed(testEnv.handle.db, project.id, 0)).toEqual({
      commitmentUsdMicros: 1500,
      budgetLimitUsdMicros: 1000,
    });
    expect(() => assertReservationAllowed(testEnv.handle.db, project.id, 1)).toThrow(
      "The project budget would be exceeded.",
    );
  });

  it("rejects negative or unsafe reservations", () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Invalid");
    expect(() => assertReservationAllowed(testEnv.handle.db, project.id, -1)).toThrow(
      "Reservation must be a nonnegative integer.",
    );
    expect(() => assertReservationAllowed(testEnv.handle.db, project.id, 1.5)).toThrow(
      "Reservation must be a nonnegative integer.",
    );
  });
});
