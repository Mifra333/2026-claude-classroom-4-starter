// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateA2UIComponents } from "@ag-ui/a2ui-toolkit";
import type { RequestContext } from "@mastra/core/request-context";
import { migrate } from "drizzle-orm/libsql/migrator";
import { drizzle } from "drizzle-orm/libsql/node";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import { PROGRESS_SURFACE_ID, TUTOR_CATALOG_ID } from "@/lib/progress-card";
import * as schema from "@/lib/schema";
import { todos, user } from "@/lib/schema";
import { createTodoTools, tutorRequestContext } from "@/lib/todo-tools";

// Same arrangement as todo-tools.test.ts: the real statements against a
// throwaway file, so the card's figures are read off actual rows.
let dir: string;
let db: ReturnType<typeof drizzle<typeof schema>>;
let tools: ReturnType<typeof createTodoTools>;

const ada = tutorRequestContext("user-ada");
const grace = tutorRequestContext("user-grace");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-tutor-progress-card-"));
  db = drizzle({ connection: { url: `file:${join(dir, "test.db")}` }, schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  tools = createTodoTools(db);

  await db.insert(user).values([
    { id: "user-ada", name: "Ada", email: "ada@example.com" },
    { id: "user-grace", name: "Grace", email: "grace@example.com" },
  ]);
});

afterAll(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.delete(todos);
});

type Operation = Record<string, unknown>;

/**
 * `createTool` types `execute` as optional and expects the rest of the
 * execution context the runtime fills in; one cast here keeps every assertion
 * below plain, and still runs the real executor. Same shape as
 * todo-tools.test.ts's `run`.
 */
const run = <I, O>(
  tool: { execute?: (input: I, context: never) => Promise<unknown> },
  input: I,
  requestContext: RequestContext,
) => tool.execute?.(input, { requestContext } as never) as Promise<O>;

const showProgress = (requestContext: RequestContext) =>
  run<Record<string, never>, { a2ui_operations: Operation[] }>(
    tools.showProgress,
    {},
    requestContext,
  );

/** Builds a list of `total` items with the first `done` of them crossed off. */
async function seed(requestContext: RequestContext, total: number, done = 0) {
  for (let index = 0; index < total; index += 1) {
    const { todo } = await run<{ title: string }, { todo: { id: string } }>(
      tools.addTodo,
      { title: `Item ${index}` },
      requestContext,
    );

    if (index < done) {
      await run(tools.setTodoDone, { id: todo.id, done: true }, requestContext);
    }
  }
}

/** The payload of the one operation carrying `key`, whichever position it is in. */
const payloadOf = <T>(operations: Operation[], key: string) =>
  operations.find((operation) => operation[key])?.[key] as T;

const componentsOf = (operations: Operation[]) =>
  payloadOf<{ surfaceId: string; components: Operation[] }>(
    operations,
    "updateComponents",
  );

const dataOf = (operations: Operation[]) =>
  payloadOf<{ value: Record<string, unknown> }>(operations, "updateDataModel")
    .value;

test("the card is the three v0.9 operations, on one surface and our catalog", async () => {
  await seed(ada, 2, 1);

  const { a2ui_operations: operations } = await showProgress(ada);

  // Every operation carries the version, and each names exactly one of the
  // v0.9 server-to-client messages — the middleware keys off both.
  expect(operations.map((operation) => operation.version)).toEqual([
    "v0.9",
    "v0.9",
    "v0.9",
  ]);
  expect(
    operations.map(
      (operation) =>
        Object.keys(operation).filter((key) => key !== "version")[0],
    ),
  ).toEqual(["createSurface", "updateComponents", "updateDataModel"]);

  expect(operations[0].createSurface).toEqual({
    surfaceId: PROGRESS_SURFACE_ID,
    catalogId: TUTOR_CATALOG_ID,
  });
  for (const operation of operations.slice(1)) {
    const [payload] = Object.values(operation).filter(
      (value) => typeof value === "object",
    );
    expect(payload).toMatchObject({ surfaceId: PROGRESS_SURFACE_ID });
  }
});

test("the component tree passes A2UI validation with its data model bound", async () => {
  await seed(ada, 4, 3);

  const { a2ui_operations: operations } = await showProgress(ada);
  const { components } = componentsOf(operations);

  // The toolkit's own semantic check: unique ids, a reachable `root`, every
  // child resolved, no cycles, and every `{ path }` present in the data model.
  // These are exactly the failures that otherwise surface as a blank card.
  expect(
    validateA2UIComponents({ components, data: dataOf(operations) }),
  ).toEqual({ valid: true, errors: [] });

  expect(components.find((component) => component.id === "root")).toBeDefined();
  // ProgressBar is the one component the basic catalog does not supply, so the
  // card is only renderable against components/a2ui-catalog.tsx.
  expect(new Set(components.map((component) => component.component))).toEqual(
    new Set(["Card", "Column", "Text", "ProgressBar", "Row"]),
  );
});

test("the tree is authored once — only the data model moves", async () => {
  await seed(ada, 5, 2);
  const first = await showProgress(ada);

  await db.delete(todos);
  await seed(ada, 3, 3);
  const second = await showProgress(ada);

  // Two lists with nothing in common, and byte-identical components. That is
  // the whole claim: no figure is written into the tree, so nothing about the
  // card is a snapshot of whoever rendered it first.
  expect(componentsOf(second.a2ui_operations).components).toEqual(
    componentsOf(first.a2ui_operations).components,
  );
  expect(dataOf(second.a2ui_operations)).not.toEqual(
    dataOf(first.a2ui_operations),
  );

  // And every figure the card shows is reached by a path into that data.
  const bindings = componentsOf(first.a2ui_operations)
    .components.flatMap((component) => Object.values(component))
    .filter(
      (value): value is { path: string } =>
        typeof value === "object" && value !== null && "path" in value,
    )
    .map((value) => value.path);

  expect(bindings.sort()).toEqual([
    "/doneShare",
    "/doneText",
    "/openText",
    "/shareText",
  ]);
});

test("the figures in the data model are the rows, not a guess", async () => {
  await seed(ada, 8, 3);

  expect(dataOf((await showProgress(ada)).a2ui_operations)).toEqual({
    total: 8,
    done: 3,
    open: 5,
    // 3/8 is 37.5, rounded to 38; the shares always add up to 100.
    doneShare: 38,
    openShare: 62,
    shareText: "38% done",
    doneText: "3 of 8 done",
    openText: "5 open",
  });
});

test("an empty list reports zero rather than dividing by it", async () => {
  expect(dataOf((await showProgress(ada)).a2ui_operations)).toEqual({
    total: 0,
    done: 0,
    open: 0,
    doneShare: 0,
    openShare: 0,
    shareText: "0% done",
    doneText: "0 of 0 done",
    openText: "0 open",
  });
});

test("a finished list reads as 100%", async () => {
  await seed(ada, 3, 3);

  expect(dataOf((await showProgress(ada)).a2ui_operations)).toMatchObject({
    doneShare: 100,
    openShare: 0,
    doneText: "3 of 3 done",
    openText: "0 open",
  });
});

test("the card counts only the context's own list", async () => {
  await seed(ada, 2, 1);
  await seed(grace, 5, 0);

  expect(dataOf((await showProgress(ada)).a2ui_operations)).toMatchObject({
    total: 2,
    done: 1,
  });
  expect(dataOf((await showProgress(grace)).a2ui_operations)).toMatchObject({
    total: 5,
    done: 0,
  });
});
