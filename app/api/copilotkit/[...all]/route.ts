import { MastraAgent } from "@ag-ui/mastra";
import {
  CopilotRuntime,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2";
import { auth } from "@/lib/auth";
import {
  PROJECT_AGENT_ID,
  projectMastra,
  projectRequestContext,
} from "@/lib/project-agent";
import { tutorRequestContext } from "@/lib/todo-tools";
import { mastra, TUTOR_AGENT_ID } from "@/lib/tutor";

const basePath = "/api/copilotkit";

async function handler(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // The whole isolation story: `resourceId` is the verified user id and is
  // never read from the request, so the memory Mastra loads and writes belongs
  // to the caller by construction. Built per request, hence the runtime is too.
  // The same verified id reaches the todo tools through the RequestContext.
  // The bridge forwards whatever the browser sent under a separate "ag-ui"
  // key, so `userId` here cannot be overwritten from the wire.
  const agent = MastraAgent.getLocalAgent({
    mastra,
    agentId: TUTOR_AGENT_ID,
    resourceId: session.user.id,
    requestContext: tutorRequestContext(session.user.id),
  });

  // The wizard's agent, on the same endpoint and behind the same gate. The
  // bridge requires a `resourceId`, but this agent has no memory, so nothing
  // is stored under it — the verified id goes in for the same reason as above
  // rather than to scope anything. The day it plans against is this server's,
  // decided here rather than sent by the browser, which has its own clock and
  // its own time zone.
  const projectAgent = MastraAgent.getLocalAgent({
    mastra: projectMastra,
    agentId: PROJECT_AGENT_ID,
    resourceId: session.user.id,
    requestContext: projectRequestContext(
      new Date().toISOString().slice(0, 10),
    ),
  });

  const runtime = new CopilotRuntime({
    agents: { [TUTOR_AGENT_ID]: agent, [PROJECT_AGENT_ID]: projectAgent },
    // Two jobs for the one middleware. It turns the `showProgress` tool
    // result's `a2ui_operations` into a rendered surface, and
    // `injectA2UITool: true` hands the agent a `render_a2ui` tool besides, so
    // it can compose a surface of its own for whatever the card authored in
    // lib/progress-card.ts does not cover. Left unset the flag defaults to true
    // anyway once the browser sends a catalog, but the model gaining a tool is
    // too large a thing to leave to a default.
    //
    // `agents` scopes all of that to the tutor. The wizard agent is deliberately
    // outside it: it draws one authored card and must not be handed a tool for
    // inventing others, and its page reads the operations off the tool result
    // itself rather than through a surface the middleware would emit.
    a2ui: { injectA2UITool: true, agents: [TUTOR_AGENT_ID] },
  });

  return createCopilotRuntimeHandler({ runtime, basePath })(request);
}

export const GET = handler;
export const POST = handler;
