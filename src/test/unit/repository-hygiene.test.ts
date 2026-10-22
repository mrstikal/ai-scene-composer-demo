import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { describe, expect, it } from "vitest";

const TEXT_EXTENSIONS = new Set([
  ".css",
  ".example",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".sql",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const FORBIDDEN_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "absolute Linux home path", pattern: /\/home\/[A-Za-z0-9._-]+\// },
  { label: "absolute macOS home path", pattern: /\/Users\/[A-Za-z0-9._-]+\// },
  { label: "absolute Windows home path", pattern: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/ },
  { label: "OpenRouter secret key", pattern: /sk-or-v1-[A-Za-z0-9]{16,}/ },
  { label: "OpenAI project key", pattern: /sk-proj-[A-Za-z0-9_-]{16,}/ },
  { label: "non-empty OpenRouter env value", pattern: /OPENROUTER_API_KEY=[ \t]*\S+/ },
  { label: "non-empty Meta env value", pattern: /META_MODEL_API_KEY=[ \t]*\S+/ },
];

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".next",
  "agent-memory",
  "assets-local",
  "coverage",
  "data",
  "node_modules",
  "playwright-report",
  "test-results",
]);

function walk(directory: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
        files.push(...walk(join(directory, entry.name), relative));
      }
      continue;
    }
    if (entry.name.startsWith(".env") && entry.name !== ".env.example") continue;
    files.push(relative);
  }
  return files;
}

function trackedFiles(): string[] {
  if (!existsSync(join(process.cwd(), ".git"))) {
    return walk(process.cwd());
  }
  return execFileSync("git", ["ls-files", "-z"], { cwd: process.cwd() })
    .toString("utf8")
    .split("\0")
    .filter((file) => file.length > 0);
}

function isTextFile(file: string): boolean {
  return TEXT_EXTENSIONS.has(extname(file).toLowerCase());
}

describe("repository hygiene", () => {
  it("does not track local data, assets, environment files or build output", () => {
    const files = trackedFiles();
    const forbiddenPrefixes = [
      ".env",
      ".next/",
      "assets-local/",
      "data/",
      "node_modules/",
      "test-results/",
      "playwright-report/",
    ];
    const violations = files.filter(
      (file) =>
        file !== ".env.example" &&
        forbiddenPrefixes.some((prefix) => file === prefix || file.startsWith(prefix)),
    );
    expect(violations).toEqual([]);
  });

  it("contains no secrets or absolute user paths in tracked text files", () => {
    const files = trackedFiles().filter(isTextFile);
    const violations: string[] = [];

    for (const file of files) {
      if (file === "src/test/unit/repository-hygiene.test.ts") continue;
      const absolute = join(process.cwd(), file);
      if (statSync(absolute).size > 1_500_000) continue;
      const content = readFileSync(absolute, "utf8");
      for (const { label, pattern } of FORBIDDEN_PATTERNS) {
        if (pattern.test(content)) {
          violations.push(`${file}: ${label}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
