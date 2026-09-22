import { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { Todo } from "ai-tutor-api-contract";
import { and, asc, eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/libsql/node";
import { z } from "zod";
import { progressCardOperations } from "@/lib/progress-card";
import type * as schema from "@/lib/schema";
import { todos } from "@/lib/schema";

/**
 * The one key the tools read out of Mastra's `RequestContext`, and the only
 * way a user id reaches them. The route sets it from the verified session (see
 * app/api/copilotkit/[...all]/route.ts); the AG-UI bridge writes only the
 * separate "ag-ui" key, so nothing the model or the browser sends can reach it.
 * Declaring it as a schema makes an execution without one fail before the
 * statement runs rather than fall through to some default.
 */
const requestContextSchema = z.object({ userId: z.string().min(1) });

/**
 * Builds a context the tools accept; the route and the tests share it. Left on
 * the plain `RequestContext` type because that is what `getLocalAgent` takes.
 */
export function tutorRequestContext(userId: string) {
  const requestContext = new RequestContext();
  requestContext.set("userId", userId);
  return requestContext;
}

// Same shape as lib/db.ts builds, so the app hands over its own connection and
// a test hands over one on a throwaway file.
export type TodoDb = ReturnType<typeof drizzle<typeof schema>>;

const todoColumns = { id: todos.id, title: todos.title, done: todos.done };

/**
 * The one read of the list, shared by the `listTodos` tool, the page, and
 * /api/todos so all of them show the same thing, oldest item first by `seq`
 * (see lib/schema.ts). `query` is a case-insensitive
 * substring match; `instr` rather than LIKE, so `%` and `_` match literally.
 */
export function listTodosFor(db: TodoDb, userId: string, query?: string) {
  const needle = query?.trim();
  return db
    .select(todoColumns)
    .from(todos)
    .where(
      and(
        eq(todos.userId, userId),
        needle
          ? sql`instr(lower(${todos.title}), lower(${needle})) > 0`
          : undefined,
      ),
    )
    .orderBy(asc(todos.seq));
}

/** The one insert, shared by the `addTodo` tool and `POST /api/todos`. */
export async function addTodoFor(db: TodoDb, userId: string, title: string) {
  const [row] = await db
    .insert(todos)
    .values({ userId, title: title.trim() })
    .returning(todoColumns);
  return row;
}

/**
 * The one update, shared by the `setTodoDone` tool and `PATCH /api/todos/:id`.
 * Filtered by `userId` as well as `id`, so another user's item comes back as
 * `null` — indistinguishable from an id that does not exist.
 */
export async function setTodoDoneFor(
  db: TodoDb,
  userId: string,
  id: string,
  done: boolean,
) {
  const [row] = await db
    .update(todos)
    .set({ done })
    .where(and(eq(todos.id, id), eq(todos.userId, userId)))
    .returning(todoColumns);
  return row ?? null;
}

/**
 * The one tally of the list, behind the `showProgress` tool. Counted by SQLite
 * over the rows themselves rather than over a fetched array, so the figures on
 * the card are the database's answer and the model is never asked for them.
 *
 * An empty list has no share to report. 0% is the honest reading of it, and it
 * keeps the card's single component tree valid rather than needing a second
 * one for the empty case.
 */
export async function todoProgressFor(db: TodoDb, userId: string) {
  const [row] = await db
    .select({
      total: sql<number>`count(*)`,
      done: sql<number>`coalesce(sum(${todos.done}), 0)`,
    })
    .from(todos)
    .where(eq(todos.userId, userId));

  const total = Number(row?.total ?? 0);
  const done = Number(row?.done ?? 0);
  // Rounded once and subtracted, so the two shares always add up to 100.
  const doneShare = total === 0 ? 0 : Math.round((done / total) * 100);

  return {
    total,
    done,
    open: total - done,
    doneShare,
    openShare: total === 0 ? 0 : 100 - doneShare,
  };
}

export type TodoProgress = Awaited<ReturnType<typeof todoProgressFor>>;

export type TodoItem = Awaited<ReturnType<typeof listTodosFor>>[number];

/**
 * The tutor's write path onto lib/schema.ts's `todos`. Every statement is
 * filtered by the context's `userId`, so a row belonging to another student is
 * invisible rather than merely forbidden — `setTodoDone` on a stolen id reads
 * as "no such item".
 */
export function createTodoTools(db: TodoDb) {
  const listTodos = createTool({
    id: "listTodos",
    description:
      "Read the student's whole to-do list, open and completed items alike. Call this before answering any question about what is on the list.",
    inputSchema: z.object({}),
    outputSchema: z.object({ todos: z.array(Todo) }),
    requestContextSchema,
    // `requestContext` is typed by requestContextSchema and always present.
    execute: async (_input, { requestContext }) => ({
      todos: await listTodosFor(db, requestContext.get("userId")),
    }),
  });

  const addTodo = createTool({
    id: "addTodo",
    description:
      "Put one new item on the student's to-do list. Pass the item as a short imperative phrase; call it once per item.",
    inputSchema: z.object({
      title: z.string().min(1).describe("The item, e.g. 'Buy milk'"),
    }),
    outputSchema: z.object({ todo: Todo }),
    requestContextSchema,
    execute: async ({ title }, { requestContext }) => ({
      todo: await addTodoFor(db, requestContext.get("userId"), title),
    }),
  });

  const setTodoDone = createTool({
    id: "setTodoDone",
    description:
      "Mark one item on the student's list completed, or put it back to open. Take the id from listTodos.",
    inputSchema: z.object({
      id: z.string().min(1).describe("The item's id, as listTodos reported it"),
      done: z.boolean().describe("true to complete it, false to reopen it"),
    }),
    outputSchema: z.object({
      todo: Todo.nullable().describe(
        "null when the student's list holds no item with that id",
      ),
    }),
    requestContextSchema,
    execute: async ({ id, done }, { requestContext }) => ({
      todo: await setTodoDoneFor(db, requestContext.get("userId"), id, done),
    }),
  });

  const showProgress = createTool({
    id: "showProgress",
    description:
      "Show the student a card in the chat with how much of their list is done. The card carries its own figures, read from the list — do not work them out or repeat them yourself.",
    inputSchema: z.object({}),
    // An A2UI operation is an open envelope by design, so the shape is checked
    // where it matters (lib/progress-card.ts and its test) rather than here.
    outputSchema: z.object({
      a2ui_operations: z.array(z.record(z.string(), z.unknown())),
    }),
    requestContextSchema,
    // One read, then the card the operations already describe. The tool does
    // not ask a model to design anything, so a card costs no extra LLM call.
    execute: async (_input, { requestContext }) => ({
      a2ui_operations: progressCardOperations(
        await todoProgressFor(db, requestContext.get("userId")),
      ),
    }),
  });

  return { listTodos, addTodo, setTodoDone, showProgress };
}
