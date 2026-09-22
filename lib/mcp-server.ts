import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/server";
import {
  CreateTodoRequest,
  ListTodosResponse,
  mcpToolResult,
  mcpTools,
  Todo,
} from "ai-tutor-api-contract";
import { z } from "zod";
import { readView } from "@/lib/mcp-app-views";
import {
  addTodoFor,
  listTodosFor,
  setTodoDoneFor,
  type TodoDb,
} from "@/lib/todo-tools";

/** The folder under mcp-apps/ whose build this server serves. */
const TODO_FORM_VIEW = "todo-form";

/**
 * Where the form lives as far as a host is concerned. A `ui://` uri is never
 * fetched: the host asks this server for the resource over MCP and renders
 * what comes back, so the authority is a name rather than an origin.
 */
export const TODO_FORM_RESOURCE_URI = "ui://ai-tutor/todo-form.html";

/**
 * What the form's list shows, and what both of its tools hand back: the items
 * still to do, oldest first. Filtering a fetched array rather than a fourth
 * query, because "open" is this one view's idea of what to show rather than
 * anything the ledger knows about.
 */
async function openTodosFor(db: TodoDb, userId: string) {
  return (await listTodosFor(db, userId)).filter((todo) => !todo.done);
}

/**
 * The `ai-tutor mcp --stdio` tools served from inside the app: same names,
 * descriptions, and schemas (from the contract), but straight onto the todos
 * table instead of through /api/todos. `userId` is fixed when the server is
 * built, and app/api/mcp/route.ts builds one per request from the verified
 * access token, so no tool argument can name another user's list.
 *
 * Plus one tool the contract does not carry: `open_todo_form`, which opens an
 * MCP App in the host's own conversation. It is declared here rather than in
 * `mcpTools` because the CLI's stdio server registers everything in there, and
 * a terminal has nowhere to draw a form.
 *
 * `viewsDir` is there for tests, the same way `readView`'s second parameter
 * is: the built views are git-ignored, so a checkout that has never run
 * `npm run build:views` still has a server to talk to.
 */
export function createTodoMcpServer(
  db: TodoDb,
  userId: string,
  viewsDir?: string,
) {
  const server = new McpServer({ name: "ai-tutor", version: "0.1.0" });

  server.registerTool("list_todos", mcpTools.list_todos, async ({ q }) =>
    mcpToolResult({ todos: await listTodosFor(db, userId, q) }),
  );

  server.registerTool("add_todo", mcpTools.add_todo, async ({ title }) =>
    mcpToolResult({ todo: await addTodoFor(db, userId, title) }),
  );

  server.registerTool(
    "mark_todo_done",
    mcpTools.mark_todo_done,
    async ({ id }) => {
      const todo = await setTodoDoneFor(db, userId, id, true);
      // Thrown errors become `isError` results; another user's id reads as
      // unknown, same as PATCH /api/todos/:id answering 404.
      if (!todo) throw new Error(`not_found: no to-do with id ${id}`);
      return mcpToolResult({ todo });
    },
  );

  /**
   * `registerAppTool` is `registerTool` plus the UI metadata, and the
   * normalising is the reason to use it: it writes `_meta.ui.resourceUri` and
   * the older `_meta["ui/resourceUri"]` beside it, so a host on either
   * spelling finds the view. One that does not do MCP Apps at all ignores both
   * and reads the text below, which is why that text says what was opened.
   */
  registerAppTool(
    server,
    "open_todo_form",
    {
      title: "Open the to-do form",
      description:
        "Open a small form in the conversation so the user can add one to-do themselves. Pass `title` to draft the item for them; they can still edit it before adding it. Use add_todo instead when they have already said what to put on the list.",
      inputSchema: z.object({
        title: z
          .string()
          .trim()
          .optional()
          .describe(
            "A draft title to put in the form's field. Leave it out for an empty form.",
          ),
      }),
      // The list the form shows. It travels as the tool *result*, which the
      // host delivers to the view as a notification, so the form has it on the
      // first paint rather than after a round trip of its own.
      outputSchema: ListTodosResponse,
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: TODO_FORM_RESOURCE_URI } },
    },
    async ({ title }) => ({
      // Not `mcpToolResult`: the text here is the fallback a host without MCP
      // Apps shows, and a sentence serves that better than the JSON beside it.
      content: [
        {
          type: "text",
          text: title
            ? `Opened the to-do form, with "${title}" drafted in it.`
            : "Opened the to-do form.",
        },
      ],
      structuredContent: { todos: await openTodosFor(db, userId) },
    }),
  );

  /**
   * The other half of the form: the model drafts, the human commits.
   *
   * `visibility: ["app"]` is what keeps those apart. It marks the tool as
   * callable by this server's own view and by nothing else, so the model
   * cannot reach past the user's hand on the button — and `add_todo` is still
   * there for when the user has simply said what to write down. Like
   * `open_todo_form` it stays out of `mcpTools`, which the CLI registers
   * wholesale into a terminal that has no form to submit.
   *
   * Nothing here trusts the view: the title goes through the contract's own
   * `CreateTodoRequest`, and the row is written for the user the OAuth token
   * named, which the view has no say in.
   */
  registerAppTool(
    server,
    "submit_todo_form",
    {
      title: "Save the to-do form",
      description:
        "Save the to-do the user typed into the form. The form calls this itself when they press Add; it is not for the assistant to call.",
      inputSchema: CreateTodoRequest,
      // Both, because the form shows both: what was just saved, and the list
      // it has just joined.
      outputSchema: z.object({ todo: Todo, todos: z.array(Todo) }),
      annotations: { readOnlyHint: false, idempotentHint: false },
      _meta: {
        ui: { resourceUri: TODO_FORM_RESOURCE_URI, visibility: ["app"] },
      },
    },
    async ({ title }) => {
      const todo = await addTodoFor(db, userId, title);
      return mcpToolResult({ todo, todos: await openTodosFor(db, userId) });
    },
  );

  /**
   * The view itself, as the one self-contained document
   * `npm run build:views` writes. The host reads this once and renders it in a
   * sandboxed iframe — see scripts/build-views.mjs for why nothing inside it
   * may be a second request.
   */
  registerAppResource(
    server,
    "New to-do form",
    TODO_FORM_RESOURCE_URI,
    { description: "The form open_todo_form opens." },
    async () => ({
      contents: [
        {
          uri: TODO_FORM_RESOURCE_URI,
          // "text/html;profile=mcp-app" — what tells the host this HTML is an
          // MCP App rather than a document to show as text.
          mimeType: RESOURCE_MIME_TYPE,
          text: await readView(TODO_FORM_VIEW, viewsDir),
        },
      ],
    }),
  );

  return server;
}
