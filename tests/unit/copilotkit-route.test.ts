// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

// Both are `server-only` and open a database on import, so the gate is tested
// against stand-ins; only the branch before them is under test here.
const getSession = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/tutor", () => ({ TUTOR_AGENT_ID: "tutor", mastra: {} }));

const getLocalAgent = vi.fn(
  (_options: {
    agentId: string;
    requestContext: { get(key: string): unknown };
  }) => ({ agentId: "tutor" }),
);
vi.mock("@ag-ui/mastra", () => ({ MastraAgent: { getLocalAgent } }));

const runtimeHandler = vi.fn(async () => new Response("ok"));
const copilotRuntime = vi.fn(function CopilotRuntime(this: unknown) {});
vi.mock("@copilotkit/runtime/v2", () => ({
  CopilotRuntime: copilotRuntime,
  createCopilotRuntimeHandler: vi.fn(() => runtimeHandler),
}));

const { GET, POST } = await import("@/app/api/copilotkit/[...all]/route");

const runRequest = () =>
  new Request("http://localhost/api/copilotkit/agent/tutor/run", {
    method: "POST",
    body: "{}",
  });

describe("the CopilotKit route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("rejects a request without a session and never reaches the agent", async () => {
    getSession.mockResolvedValue(null);

    const response = await POST(runRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(getLocalAgent).not.toHaveBeenCalled();
    expect(runtimeHandler).not.toHaveBeenCalled();
  });

  test("gates GET as well, so the agent is not discoverable either", async () => {
    getSession.mockResolvedValue(null);

    const response = await GET(
      new Request("http://localhost/api/copilotkit/info"),
    );

    expect(response.status).toBe(401);
    expect(runtimeHandler).not.toHaveBeenCalled();
  });

  test("scopes the agent's memory to the session's user id", async () => {
    getSession.mockResolvedValue({ user: { id: "user-a" } });

    const response = await POST(runRequest());

    expect(response.status).toBe(200);
    expect(getLocalAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "tutor", resourceId: "user-a" }),
    );
  });

  test("hands the todo tools that same id through the request context", async () => {
    getSession.mockResolvedValue({ user: { id: "user-a" } });

    await POST(runRequest());

    const { requestContext } = getLocalAgent.mock.calls[0][0];
    expect(requestContext.get("userId")).toBe("user-a");
  });

  test("takes the user id from the session, not from the request", async () => {
    getSession.mockResolvedValue({ user: { id: "user-b" } });

    await POST(
      new Request("http://localhost/api/copilotkit/agent/tutor/run", {
        method: "POST",
        headers: { "x-user-id": "user-a" },
        body: JSON.stringify({ threadId: "tutor:user-a" }),
      }),
    );

    expect(getLocalAgent).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "user-b" }),
    );
  });

  test("gives the tutor the A2UI render tool, and only the tutor", async () => {
    getSession.mockResolvedValue({ user: { id: "user-a" } });

    await POST(runRequest());

    // `injectA2UITool` decides whether a model may compose surfaces of its own,
    // and unset it follows the browser — a catalog on the provider turns it on.
    // `agents` decides which model that is. Both are pinned here: the wizard
    // agent draws one authored card and is meant to have no such tool.
    expect(copilotRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        a2ui: { injectA2UITool: true, agents: ["tutor"] },
      }),
    );
  });

  test("serves the wizard agent from the same gated endpoint", async () => {
    getSession.mockResolvedValue({ user: { id: "user-a" } });

    await POST(runRequest());

    expect(getLocalAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "project", resourceId: "user-a" }),
    );
    // It has no clock of its own and the browser's is not to be trusted, so
    // the day it plans against comes from here.
    const project = getLocalAgent.mock.calls.find(
      ([options]) => options.agentId === "project",
    );
    expect(project?.[0].requestContext.get("today")).toMatch(
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/,
    );
  });
});
