// No framework, and exactly one import: `@modelcontextprotocol/ext-apps` is
// the only thing this view needs that the DOM does not already give it. Vite
// folds the reachable part of it into the built file, so the page still
// arrives as one document and still makes no second request.

import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";

const titleInput = document.getElementById("todo-title") as HTMLInputElement;
const addButton = document.getElementById("add-todo") as HTMLButtonElement;
const statusLine = document.getElementById("status") as HTMLParagraphElement;
const openList = document.getElementById("open-todos") as HTMLUListElement;
const openEmpty = document.getElementById(
  "open-todos-empty",
) as HTMLParagraphElement;

/** Prefills the input with the title the tool was called with. */
export function setTitle(text: string) {
  titleInput.value = text;
  syncAddButton();
}

export function setStatus(text: string, kind: "info" | "error" = "info") {
  statusLine.textContent = text;
  statusLine.dataset.kind = kind;
}

export function renderOpenTodos(
  items: { id: number | string; title: string }[],
) {
  openList.replaceChildren(
    ...items.map((item) => {
      const row = document.createElement("li");
      row.dataset.id = String(item.id);
      // textContent, never innerHTML: a to-do title is someone's own text.
      row.textContent = item.title;
      return row;
    }),
  );
  openEmpty.hidden = items.length > 0;
}

/** An empty title is not a to-do, so the button says so before the click does. */
function syncAddButton() {
  addButton.disabled = titleInput.value.trim() === "";
}

/**
 * This view is itself an MCP client, and the host is its server, across the
 * iframe boundary. `connect()` with no transport builds the
 * `PostMessageTransport` that talks over it.
 */
const app = new App({ name: "ai-tutor-todo-form", version: "0.1.0" });

/** What `submit_todo_form` hands back; `open_todo_form` returns the list half. */
type Saved = {
  todo: { id: string; title: string };
  todos: { id: string; title: string }[];
};

/**
 * The message out of a tool result. A refusal puts its reason where a success
 * puts its text, and neither has a typed field of its own.
 */
function firstText(result: { content?: unknown }): string | undefined {
  const blocks = Array.isArray(result.content) ? result.content : [];
  for (const block of blocks) {
    if (
      typeof block === "object" &&
      block !== null &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      return block.text;
    }
  }
  return undefined;
}

/** One line for the model, listing what is open after a save. */
function savedForModel({ todo, todos }: Saved) {
  const open =
    todos.length > 0
      ? `Their open to-dos are now: ${todos.map((item) => item.title).join(", ")}.`
      : "Nothing is open on their list.";
  return `The user added "${todo.title}" from the to-do form. ${open}`;
}

/**
 * Add, which is where the human commits what the model drafted.
 *
 * `callServerTool` goes to the host, which proxies it back to the server this
 * view came from. The view never reaches a database and never names a user: it
 * asks for `submit_todo_form`, which is marked `visibility: ["app"]` precisely
 * so that this is its only caller.
 */
async function onSubmit(title: string) {
  addButton.disabled = true;
  setStatus("Saving…");

  try {
    const result = await app.callServerTool({
      name: "submit_todo_form",
      arguments: { title },
    });

    // A refused title comes back as a *result* with `isError`; only the
    // transport throws. The button will not send an empty title, but the
    // server is the authority on what a to-do is, so whatever it refuses is
    // shown here rather than swallowed.
    if (result.isError) {
      setStatus(firstText(result) ?? "That to-do was not saved.", "error");
      return;
    }

    const saved = result.structuredContent as Saved | undefined;
    if (!saved) {
      setStatus(
        "The to-do was saved, but the form could not read it.",
        "error",
      );
      return;
    }

    setTitle("");
    renderOpenTodos(saved.todos);
    setStatus(`Added "${saved.todo.title}".`);

    // The model saw none of this: the host proxied the call, and nothing of it
    // reached the transcript. This is what puts it there, so the next turn
    // already knows what the list holds instead of going to look.
    void app.updateModelContext({
      content: [{ type: "text", text: savedForModel(saved) }],
    });
  } catch {
    // The host is gone, or would not proxy. Nothing was saved.
    setStatus("The form could not reach the server.", "error");
  } finally {
    syncAddButton();
  }
}

function submit() {
  const title = titleInput.value.trim();
  if (title === "") return;
  void onSubmit(title);
}

titleInput.addEventListener("input", syncAddButton);
titleInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  // The view is one field, so Enter is the submit an outer <form> would give.
  event.preventDefault();
  submit();
});
addButton.addEventListener("click", submit);

syncAddButton();
renderOpenTodos([]);

/**
 * The host's own look, as far as a sandboxed document can take it.
 * `applyDocumentTheme` sets `data-theme` on `<html>`, which is the second of
 * the two dark selectors style.css already carries — so the host wins over the
 * operating system in both directions. `applyHostStyleVariables` writes the
 * host's CSS variables onto the same element, where a `var()` can reach them,
 * and `applyHostFonts` adds whatever font faces the host offers, which is the
 * one way a view gets a typeface without a request the CSP would refuse.
 *
 * Every field is checked on its own because this runs twice for two different
 * shapes: the whole context once the handshake is done, then, whenever
 * something changes, only the part that changed. A host switching to dark
 * mid-conversation sends `theme` and nothing else, and an unguarded read would
 * clear the rest.
 */
function applyHostContext(context: McpUiHostContext | undefined) {
  if (!context) return;
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) {
    applyHostStyleVariables(context.styles.variables);
  }
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
}

// Every handler before `connect()`, which is the one ordering rule here: the
// host sends the tool input and the tool result as notifications as soon as
// the handshake is done, and a handler registered after that has missed them.
app.ontoolinput = ({ arguments: args }) => {
  const title = args?.title;
  // `title` is optional on the tool, so the model may have drafted nothing.
  // The form is the user's to fill in either way.
  if (typeof title === "string") setTitle(title);
};

// `open_todo_form` returns the open list, so the form has it on the first
// paint rather than after a round trip of its own.
app.ontoolresult = (result) => {
  const opened = result.structuredContent as Pick<Saved, "todos"> | undefined;
  if (opened?.todos) renderOpenTodos(opened.todos);
};

app.onhostcontextchanged = applyHostContext;

void app.connect().then(
  // The first context is not a notification — it comes back in the reply to
  // the handshake, so it is read rather than delivered.
  () => applyHostContext(app.getHostContext()),
  () => {
    // Nobody on the other side: the built file opened straight from
    // mcp-apps/dist, which is how the CodeTour looks at it. The form still
    // renders and still validates; it simply has no host to talk to.
  },
);
