// @vitest-environment node
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { mcpTools } from "ai-tutor-api-contract";
import { migrate } from "drizzle-orm/libsql/migrator";
import { drizzle } from "drizzle-orm/libsql/node";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createTodoMcpServer, TODO_FORM_RESOURCE_URI } from "@/lib/mcp-server";
import * as schema from "@/lib/schema";
import { user } from "@/lib/schema";
import { makeTempDir, removeTempDir } from "@/tests/support/temp-dir";

// lib/mcp-app-views is `server-only`, which resolves to its throwing build
// outside Next.js; nothing it guards is reached here.
vi.mock("server-only", () => ({}));

const view = "<!doctype html><title>New to-do</title><p>form</p>";

type Todo = { id: string; title: string; done: boolean };

let dir: string;
let db: ReturnType<typeof drizzle<typeof schema>>;
let ada: Client;
let grace: Client;

/** A client on its own in-process server, for one user, like one OAuth token. */
async function clientFor(userId: string) {
  const server = createTodoMcpServer(db, userId, dir);
  const client = new Client({ name: `test-${userId}`, version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args });

beforeAll(async () => {
  // The built views are git-ignored, so the server reads a throwaway file the
  // same way tests/unit/mcp-app-views.test.ts does — `npm test` must pass on a
  // checkout that has never run `npm run build:views`.
  dir = await makeTempDir("ai-tutor-mcp-server-");
  await writeFile(join(dir, "todo-form.html"), view);

  db = drizzle({ connection: { url: `file:${join(dir, "test.db")}` }, schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  // todos.userId is a FK onto the Better Auth user table.
  await db.insert(user).values([
    { id: "user-ada", name: "Ada", email: "ada@example.com" },
    { id: "user-grace", name: "Grace", email: "grace@example.com" },
  ]);

  [ada, grace] = await Promise.all([
    clientFor("user-ada"),
    clientFor("user-grace"),
  ]);
});

afterAll(async () => {
  await Promise.all([ada.close(), grace.close()]);
  db.$client.close();
  await removeTempDir(dir);
});

describe("the app's MCP server", () => {
  test("offers both form tools beside the three the CLI also has", async () => {
    const { tools } = await ada.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "add_todo",
      "list_todos",
      "mark_todo_done",
      "open_todo_form",
      "submit_todo_form",
    ]);
    // Neither form tool is in the contract: the CLI's stdio server registers
    // everything in `mcpTools`, and a terminal can neither draw a form nor
    // submit one.
    expect(Object.keys(mcpTools)).not.toContain("open_todo_form");
    expect(Object.keys(mcpTools)).not.toContain("submit_todo_form");
  });

  test("marks submit_todo_form app-only, and open_todo_form not", async () => {
    const { tools } = await ada.listTools();
    const uiMeta = (name: string) =>
      tools.find((tool) => tool.name === name)?._meta?.ui as
        | { resourceUri?: string; visibility?: string[] }
        | undefined;

    // The model drafts and the human commits: saving is reachable from the
    // view and from nowhere else, which is what this one field says.
    expect(uiMeta("submit_todo_form")).toEqual({
      resourceUri: TODO_FORM_RESOURCE_URI,
      visibility: ["app"],
    });
    // Opening the form is the model's to do, so it carries no visibility at
    // all and defaults to both.
    expect(uiMeta("open_todo_form")?.visibility).toBeUndefined();
  });

  test("links both form tools to the same ui:// resource", async () => {
    const { tools } = await ada.listTools();

    for (const name of ["open_todo_form", "submit_todo_form"]) {
      const meta = tools.find((tool) => tool.name === name)?._meta as
        | { ui?: { resourceUri?: string }; "ui/resourceUri"?: string }
        | undefined;

      expect(meta?.ui?.resourceUri).toBe(TODO_FORM_RESOURCE_URI);
      // `registerAppTool` writes the older spelling too, for hosts still on it.
      expect(meta?.["ui/resourceUri"]).toBe(TODO_FORM_RESOURCE_URI);
    }
  });

  test("serves that resource as an MCP App, not as a page", async () => {
    const { contents } = await ada.readResource({
      uri: TODO_FORM_RESOURCE_URI,
    });

    expect(contents).toHaveLength(1);
    // The profiled MIME type is the whole difference: it is what tells the
    // host to render the HTML in its sandbox rather than show it as text.
    // Matched as a whole because a resource's contents are text *or* bytes,
    // and reading `.text` off that union is not a thing the types allow.
    expect(contents[0]).toMatchObject({
      uri: TODO_FORM_RESOURCE_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: view,
    });
  });

  test("saves the form for the calling user, and for nobody else", async () => {
    const saved = await call(ada, "submit_todo_form", { title: "Buy milk" });
    await call(grace, "submit_todo_form", { title: "Call Bob" });

    // What the form shows after a save: the item, and the list it joined.
    expect(saved.structuredContent).toMatchObject({
      todo: { title: "Buy milk", done: false },
      todos: [{ title: "Buy milk", done: false }],
    });

    // The user is the OAuth token's, fixed when the server was built, so
    // Grace's item is not merely forbidden here — it is invisible.
    const titles = (result: { structuredContent?: unknown }) =>
      ((result.structuredContent as { todos: Todo[] }).todos ?? []).map(
        (todo) => todo.title,
      );
    expect(titles(await call(ada, "open_todo_form", {}))).toEqual(["Buy milk"]);
    expect(titles(await call(grace, "open_todo_form", {}))).toEqual([
      "Call Bob",
    ]);
  });

  test("refuses a title that is not one, and saves nothing", async () => {
    const before = await call(grace, "open_todo_form", {});
    const refused = await call(grace, "submit_todo_form", { title: "   " });

    // `CreateTodoRequest` trims and requires one character, so an empty title
    // never reaches the table; the view shows the refusal beside the field.
    expect(refused.isError).toBe(true);
    expect(await call(grace, "open_todo_form", {})).toMatchObject({
      structuredContent: (before as { structuredContent: unknown })
        .structuredContent as object,
    });
  });

  test("the form opens with the open list, and with or without a draft", async () => {
    const drafted = await call(ada, "open_todo_form", { title: "Buy bread" });
    const empty = await call(ada, "open_todo_form", {});

    // The text is the fallback for a host that cannot render a view, and it is
    // what the model reads back, so it says what was opened.
    expect(drafted.content).toEqual([
      {
        type: "text",
        text: 'Opened the to-do form, with "Buy bread" drafted in it.',
      },
    ]);
    expect(empty.content).toEqual([
      { type: "text", text: "Opened the to-do form." },
    ]);
    // The list travels beside the text, so the form has it on the first paint.
    expect(empty.structuredContent).toMatchObject({
      todos: [{ title: "Buy milk" }],
    });
  });
});
