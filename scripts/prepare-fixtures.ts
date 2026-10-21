import nextEnv from "@next/env";

import { fixturesRoot } from "../src/lib/config/fixtures";
import { prepareFixtures } from "../src/lib/fixtures/prepare";

async function main(): Promise<void> {
  nextEnv.loadEnvConfig(process.cwd());
  const root = fixturesRoot(process.cwd());
  const manifest = await prepareFixtures(root);

  process.stdout.write("Fixtures prepared.\n");
  for (const fixture of manifest.fixtures) {
    process.stdout.write(
      `- ${fixture.fixtureId}: ${fixture.provenance} (${fixture.selectedPath})\n`,
    );
  }
  process.stdout.write(
    `Licensed photos ready: ${manifest.licensedPhotosReady ? "yes" : "no"}\n`,
  );
  process.stdout.write(`SAM fixtures ready: ${manifest.samFixtureReady ? "yes" : "no"}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Fixture preparation failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
