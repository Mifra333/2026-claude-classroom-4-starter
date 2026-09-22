import { MastraAgent } from "@ag-ui/mastra";
import {
  CopilotRuntime,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2";
import { auth } from "@/lib/auth";
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

  const runtime = new CopilotRuntime({
    agents: { [TUTOR_AGENT_ID]: agent },
    // Two jobs for the one middleware. It turns the `showProgress` tool
    // result's `a2ui_operations` into a rendered surface, and
    // `injectA2UITool: true` hands the agent a `render_a2ui` tool besides, so
    // it can compose a surface of its own for whatever the card authored in
    // lib/progress-card.ts does not cover. Left unset the flag defaults to true
    // anyway once the browser sends a catalog, but the model gaining a tool is
    // too large a thing to leave to a default.
    a2ui: { injectA2UITool: true },
  });

  return createCopilotRuntimeHandler({ runtime, basePath })(request);
}

export const GET = handler;
export const POST = handler;
