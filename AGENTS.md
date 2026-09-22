# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

# ai-tutor

AI tutoring web app on Next.js 16 App Router + React 19 + Tailwind v4: a Mastra agent (Bartholomew, a butler who keeps the user's to-do list) served to a CopilotKit chat over AG-UI, behind Better Auth email/password sign-in, over a Drizzle/SQLite persistence layer, with a Vitest + Playwright test harness. The same list is reachable through a REST API, a CLI, and two MCP servers.

The source is commented where a decision is not obvious; this file is the map, plus the traps that no single file shows. Open the file before asking here.

## Map

```
app/
  layout.tsx, globals.css         root layout; design tokens and the CopilotKit theme bridge
  page.tsx                        `/`, the chat page (session-gated Server Component)
  login/, signup/                 email/password forms (client components)
  projects/new/                   project wizard; its card is an A2UI surface outside any chat
  device/, consent/               approval pages for the CLI device flow and for MCP OAuth
  api/auth/[...all]/              Better Auth handler
  api/copilotkit/[...all]/        AG-UI bridge: session → Mastra agent → CopilotKit runtime
  api/todos/, api/todos/[id]/     REST API over lib/todo-tools.ts
  api/mcp/                        MCP server over HTTP, OAuth-protected
  .well-known/                    OAuth discovery documents, handed to Better Auth
components/
  chat.tsx                        CopilotKit provider, CopilotChat, and the sidebar in one tree
  todos-sidebar.tsx               read-only mirror of the list; the agent is the browser's only write path
  todo-tool-calls.tsx             useRenderTool renderers for the three list-writing tools
  a2ui-catalog.tsx                the A2UI catalog: the basic components plus this app's ProgressBar
  project-wizard.tsx              runs the wizard agent and renders its surface itself — no CopilotChat
  device-approval.tsx, oauth-consent.tsx, sign-out-button.tsx
  ui/                             presentational primitives — extend one instead of repeating its class string
lib/
  tutor.ts                        the whole agent: instructions, model, memory, tools
  todo-tools.ts                   every todo query; the agent tools, the REST routes and both MCP servers call it
  progress-card.ts                the progress card's A2UI component tree and its operations, authored once
  project-agent.ts, project-card.ts   the wizard's agent and its one tool; that card's tree and the state that travels with it
  db.ts, schema.ts, auth-schema.ts   cached Drizzle connection; app tables; generated auth tables
  auth.ts, auth-config.ts, auth-cli.ts, auth-client.ts   server instance; shared options; auth:generate target; browser client
  api-route.ts                    bearer-only session and JSON helpers for /api/todos
  mcp-server.ts, mcp-app-views.ts MCP server factory, including its one MCP App; reader for built views
  project.ts, tool-result.ts      wizard rules (plain module); AG-UI tool-result decoding
packages/api-contract/            zod request/response schemas and MCP tool definitions shared by app and CLI
cli/                              `ai-tutor` CLI (commander, esbuild-bundled) including `mcp --stdio`
mcp-apps/<name>/ → mcp-apps/dist/ MCP App views, each bundled into one HTML file by scripts/build-views.mjs
  todo-form/view.ts               the view's own half of MCP: an ext-apps `App` that calls back and saves
drizzle/                          generated migrations
tests/unit, tests/integration     Vitest (node env by default; *.test.tsx is jsdom)
tests/support/                    helpers the suites share; outside the include glob, so never collected
tests/e2e                         Playwright against its own `next dev`
docs/mcp.md                       registering both MCP servers with Claude Code
.agents/skills/ (+ .claude/skills/ copy)   ai-tutor-design, ai-tutor-cli, add-app-to-server, copilotkit, mastra
.tours/                           CodeTours the README points at
```

## Commands

- `npm run dev` / `build` / `start`; `npm run lint` (`biome check`) and `npm run format` — Biome only, never add ESLint or Prettier.
- `npm test` (Vitest), `npm run test:e2e` (Playwright), `npm run test:e2e:llm` (the one spec that spends OpenRouter credit).
- Schema change: edit `lib/schema.ts`, then `npm run db:generate` and `npm run db:migrate`.
- Auth change that touches tables: `npm run auth:generate` (rewrites `lib/auth-schema.ts` wholesale), then `db:generate` and `db:migrate`.
- `npm install` builds the CLI through its `prepare` script; rebuild after edits with `npm run build -w ai-tutor-cli`.
- `npm run build:views` bundles the MCP App views; `predev`/`prebuild` run it, but `next dev` does not watch `mcp-apps/`, so re-run it by hand after editing a view.

## Gotchas

### Build and tooling

- `PageProps<'/route'>` and `LayoutProps<'/route'>` are globals generated by `next dev`/`next build`/`next typegen`, so generate them before typechecking a clean checkout.
- If Turbopack fails to replace a symlink under `.next/dev/node_modules`, stop the server and delete that generated directory.
- If a build reports stale generated route types while `tsc --noEmit --incremental false` passes, delete `.next/cache/.tsbuildinfo`.
- TypeScript is v7, so `next build` type-checks by shelling out to the project-local `tsc` and prints plain diagnostics without code frames.
- `npm run format` skips assist actions such as import sorting; use `npx biome check --write <path>` for those.
- The e2e and CLI test servers set `NEXT_DIST_DIR` (`.next-e2e`, `.next-cli-test`) to coexist with a running `npm run dev`; `next dev` adds their type dirs to `tsconfig.json` itself and reformats the file, so run `npm run format` afterwards.
- `@copilotkit/runtime` drags in a zod-3 tree while Better Auth is on zod 4; npm nests the zod 3 copy under `@copilotkit/runtime/node_modules` on its own — no `.npmrc` or `--legacy-peer-deps`.
- `@modelcontextprotocol/ext-apps` 2.x is a root dependency while `@copilotkit/react-core` nests its own 1.7.5; both are expected in `npm ls`.

### Persistence and auth

- `drizzle/` is generated, except that SQLite cannot `ADD` a `NOT NULL` column without a default, so such a migration is hand-edited into a table rebuild that backfills it, as `0004` does.
- Mastra creates and owns its `mastra_*` tables in the same SQLite file; they are not in `lib/schema.ts` and `db:generate` must not try to manage them.
- The driver is `drizzle-orm/libsql/node`; do not install `better-sqlite3`.
- Every plugin that adds tables (`deviceAuthorization`, `jwt`, `mcp`, `cimd`) must be in `lib/auth-cli.ts`'s plugin array too, or its tables drop out of the next `auth:generate`.
- There is deliberately no `proxy.ts`: gate pages server-side with `auth.api.getSession` plus `redirect()`, as `app/page.tsx` does.
- `mcp()` from `@better-auth/mcp` is the OAuth provider; `@better-auth/oauth-provider` is a dependency only for its client plugin, so never add `oauthProvider()` beside `mcp()`.
- A new MCP scope has to be listed in `mcpOptions().scopes` and described in `components/oauth-consent.tsx`.
- `Authorization: Bearer` must carry the signed token from sign-in's `set-auth-token` header, not the raw session token; in tests that is `login().cookies[0].value`, not `login().token`.

### Agent and CopilotKit

- `@copilotkit/react-core/v2` and `@copilotkit/runtime/v2` (`createCopilotRuntimeHandler`) are the only surfaces that work here; `@copilotkit/react-ui`, the package roots, and the Express/Hono adapters are v1.
- CopilotKit questions go through the `copilotkit` skill, which sends you to the `copilotkit-docs` MCP server in `.mcp.json`; Mastra questions through the `mastra` skill.
- Mastra memory is durable in SQLite, but the default `InMemoryAgentRunner` also keeps a bounded replay cache that can restore the browser transcript until eviction or restart — do not mistake either for the other when debugging.
- The A2UI middleware is on with `injectA2UITool: true` (`a2ui` in the CopilotKit route), so the agent holds a `render_a2ui` tool and composes surfaces of its own beside the one authored card; unset, the flag would follow the browser instead, because a catalog on the provider turns it on.
- `includeSchema` stays `true` on the provider in `components/chat.tsx`, because the injected tool's guidelines let the model name only components it has been shown, and the middleware also reads a generated surface's catalog id off that same context entry.
- `a2ui.agents` scopes the middleware to the tutor, so the wizard agent gets no `render_a2ui` tool and no surface conversion; `components/project-wizard.tsx` reads `a2ui_operations` off the tool result itself and hands it to its own `A2UIProvider`.
- Outside a chat nobody has called `initializeDefaultCatalog()` and `injectStyles()` — `@copilotkit/react-core` does that for itself before drawing a surface in the transcript — so the wizard does it on mount or its card renders unstyled.
- The wizard agent is on its own model (`openrouter/google/gemini-3.1-flash-lite`) because the tutor's reasoning model works the dates out in its reasoning and then omits them from the tool call.
- It has no memory and each submit calls `agent.setMessages` with one message, so a run carries that instruction and nothing else; its `today` comes from the route's own clock through the `RequestContext`, never from the browser.
- The wizard's state travels instead of being remembered: the page sends the surface's live data model (`surface.dataModel.get("/")`, manual edits included) as a `copilotkit.addContext` entry, and the tool finds it again under `requestContext.get("ag-ui").context` by its description — `forwardedProps` do **not** reach a Mastra tool, only `input.context` does.
- That data model holds only what the tree binds, so the effort is the string `/effort` and the criticality the array `/criticalityChoice`; a second copy of either as a raw project field would go stale the moment someone edited the input, since the bindings write back to the bound path.
- The first `setProject` call creates the surface and every later one returns a single `updateDataModel`, so the card is amended in place — `assembleOps({ intent: "update" })` is the wrong tool for that, because it still sends `updateComponents`.
- A refused field shows in the card, in a `Text` bound to `/errors/<field>` that is in the tree from the first paint and empty when there is nothing to say; the status line carries `describeChanges` alone.
- `lib/project-agent.ts` builds a `Mastra` with no storage, so every run logs "No `storage` configured on Mastra — falling back to an in-memory store"; that is the no-memory design, not a misconfiguration.
- `showProgress` returns its operations under `a2ui_operations`, which is the only key the middleware looks for in a tool result; renaming it makes the card fall through as plain JSON.
- Every surface's `catalogId` has to be `TUTOR_CATALOG_ID` from `lib/progress-card.ts` — the authored card names it outright, a generated one inherits it from the schema context, and a mismatch renders as "Catalog not found" rather than as an error anywhere near the cause.
- `@copilotkit/a2ui-renderer` is built against zod 3 and nests its own copy, so catalog prop schemas are written with `zod/v3` (zod 4's bundled zod 3), and the two are nominally distinct types however identical at runtime — hence the casts in `components/a2ui-catalog.tsx`, not a shortcut.
- A catalog prop is bindable only if its schema is one of the renderer's `Dynamic*Schema`s; a bare `z.string()` lets an unresolved `{ path }` reach React and throws at render.

### MCP Apps

- `open_todo_form` and `submit_todo_form` are registered in `lib/mcp-server.ts` with ext-apps' `registerAppTool`/`registerAppResource` and deliberately kept out of the contract's `mcpTools`, because `cli/` registers everything in there and a terminal can neither draw a form nor submit one.
- `submit_todo_form` carries `_meta.ui.visibility: ["app"]`, which the SDK only passes through — the *host* is what keeps the model from calling it, so the tool still validates its own input and still writes for the token's user, exactly as if anyone could reach it.
- A view's `callServerTool` is proxied by the host back to the server the view came from, so the view names a tool and never a user; the row is written for the `userId` fixed when `createTodoMcpServer` was built.
- Neither form tool reaches the transcript, so after a save the view calls `updateModelContext` to tell the model what is on the list; without it the next turn would have to call `list_todos` to find out.
- A refused tool input comes back as a result with `isError`, not as a thrown error — only the transport throws — so a view that only catches is a view that silently drops refusals.
- A `ui://` uri is never fetched — the host reads the resource back off this same MCP server — so its authority is a name, and `RESOURCE_MIME_TYPE` (`text/html;profile=mcp-app`) is what marks the HTML as an App rather than as a page to show as text.
- `registerAppTool` writes both `_meta.ui.resourceUri` and the older `_meta["ui/resourceUri"]`, so do not "tidy" either away: hosts read one or the other.
- `createTodoMcpServer` takes the views directory as a third parameter for the same reason `readView` takes one — the built views are git-ignored, so no test may need them.
- In a view, every `App` handler goes on before `connect()`, because the host sends the tool input as a notification the moment the handshake is done; the first host context is the exception and is read with `getHostContext()` instead.
- `@modelcontextprotocol/client` is a devDependency although the view imports it through ext-apps' root export: `build:views` inlines it into the bundle, so like vite it is needed to build and never to run.

### Styling

- Read `.agents/skills/ai-tutor-design/SKILL.md` before touching anything visual, and update it in the same change set when a rule changes.
- `Source_Sans_3` at 400/600 is the only face loaded, so there is no `font-mono` utility to reach for.
- The chat's composer, send button and radii are hardcoded CopilotKit utilities that `globals.css` overrides by hand; after a CopilotKit upgrade, a pill-shaped composer means the overrides no longer match.

### Tests

- Vitest only picks up `tests/{unit,integration}/**/*.test.{ts,tsx}` and cannot render async Server Components, so cover those with e2e.
- Vitest does not load `.env`: tests stub `DATABASE_URL`/`BETTER_AUTH_*` onto temp files, and `server-only` resolves to its throwing build outside Next.js, so modules that import it are loaded under `vi.mock("server-only", () => ({}))`.
- A suite's throwaway directory goes through `makeTempDir`/`removeTempDir` from `tests/support/temp-dir.ts`, because Windows will not unlink an open file and a closed libSQL connection is not enough — the native driver holds the database until a garbage collection finalises the statements it prepared, which is what the helper forces.
- Every connection onto a suite's temp file therefore has to be closed in `afterAll`, including the ones `lib/db.ts` and `lib/tutor.ts` cache on `globalThis` to survive a hot reload, since `vi.resetModules()` does not drop those.
- `tests/e2e/*.spec.ts` hit `data/app.db`, so they sign up `Date.now()`-stamped emails; `*.llm.spec.ts` is ignored unless `E2E_LLM` is set.
- The token-verified path of `/api/mcp` needs the app's own JWKS over HTTP, so it has no unit test; `tests/integration/cli.test.ts` is the one place a real `next dev` is exercised from Vitest.
- That suite branches on `process.platform` three times, because Windows has no runnable `node_modules/.bin` shim (it runs `next`'s own entry point under this Node and lets cmd.exe resolve `npm`), no process group to signal (`taskkill /t` instead), and no file mode bits to assert on.

### CLI

- The `--help` text is the CLI's only documentation and is written for agents too, so change it alongside any behavior.
- `.agents/skills/ai-tutor-cli/SKILL.md` (and its `.claude/skills/` copy) only says when to reach for the CLI; update it when a command is added, renamed, or removed.

### Secrets

- `.env` holds `DATABASE_URL`, `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL`, and `OPENROUTER_API_KEY` (see `.env.example`); never commit it or print its values.

## Maintenance — for you, the agent

- Update this file in the same change set whenever a change invalidates a line here or teaches a costly lesson.
- Keep it a map plus non-obvious traps: anything a reader learns by opening the file a line points to belongs in that file's comments, not here.
- One sentence per bullet, current state only, no history.
- The two `.tours/*.tour` files anchor by line number into the files they name (`app/page.tsx`, `lib/tutor.ts`, `lib/todo-tools.ts`, the CopilotKit route, `components/`, `scripts/build-views.mjs`, `lib/mcp-app-views.ts`, `mcp-apps/todo-form/`, `package.json`, `.gitignore`, and their tests), so re-check `line` values when those statements move.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
