// @vitest-environment node
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { makeTempDir, removeTempDir } from "@/tests/support/temp-dir";

// The `server-only` package resolves to its throwing build outside Next.js;
// nothing here needs what it guards.
vi.mock("server-only", () => ({}));

// Importing lib/tutor opens a libSQL store, so point it at a throwaway file
// rather than data/app.db. No model call happens on import.
let dir: string;

const importTutor = async () => (await import("@/lib/tutor")).mastra;
const cachedStore = () =>
  (globalThis as { tutorStorage?: { close(): Promise<void> } }).tutorStorage;

beforeAll(async () => {
  dir = await makeTempDir("ai-tutor-tutor-");
  vi.stubEnv("DATABASE_URL", `file:${join(dir, "test.db")}`);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  // Both of these are cached on `globalThis` precisely so that a hot reload
  // keeps them, which means `vi.resetModules()` does not drop them either:
  // they are still holding the file when the suite ends, and only they can let
  // go. lib/tutor reaches the second one through the todo tools' `db`.
  await cachedStore()?.close();
  (globalThis as { db?: { $client: { close(): void } } }).db?.$client.close();
  await removeTempDir(dir);
});

test("a dev hot reload rebuilds the agent but keeps the connection", async () => {
  vi.stubEnv("NODE_ENV", "development");

  vi.resetModules();
  const first = await importTutor();
  const store = cachedStore();

  // What `next dev` does on every save.
  vi.resetModules();
  const second = await importTutor();

  expect(second).not.toBe(first);
  expect(cachedStore()).toBe(store);
  expect(store).toBeDefined();
});

test("production keeps the one instance", async () => {
  vi.stubEnv("NODE_ENV", "production");

  vi.resetModules();
  const first = await importTutor();
  vi.resetModules();
  const second = await importTutor();

  expect(second).toBe(first);
});
