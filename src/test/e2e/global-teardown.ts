import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export default function globalTeardown(): void {
  const marker = join(process.cwd(), "node_modules", ".cache", "scene-composer-e2e-root.txt");
  if (!existsSync(marker)) return;

  const root = readFileSync(marker, "utf8").trim();
  if (root.length > 0) {
    rmSync(root, { recursive: true, force: true });
  }
  rmSync(marker, { force: true });
}
