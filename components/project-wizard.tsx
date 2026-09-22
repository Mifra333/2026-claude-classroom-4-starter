"use client";

import {
  A2UIProvider,
  A2UIRenderer,
  initializeDefaultCatalog,
  injectStyles,
  useA2UI,
} from "@copilotkit/a2ui-renderer";
import { CopilotKit, useAgent, useCopilotKit } from "@copilotkit/react-core/v2";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { tutorCatalog } from "@/components/a2ui-catalog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PROJECT_AGENT_ID } from "@/lib/project-agent";
import {
  PROJECT_STATE_DESCRIPTION,
  PROJECT_SURFACE_ID,
} from "@/lib/project-card";
import { parseToolResult } from "@/lib/tool-result";

/**
 * The wizard: an instruction goes in, one agent run happens, and the card
 * above it is amended from the operations that run's tool returned.
 *
 * Generative UI outside a chat, which is the whole point of the page. There is
 * a `CopilotKit` provider because `useAgent` needs one, but no `CopilotChat`
 * and no transcript: the surface is rendered here by `A2UIRenderer`, from a
 * tool result this component reads itself. Nothing of the run is on screen
 * except the card and one line of status.
 *
 * The agent has no memory, so the state travels instead. The surface's data
 * model is the only copy of the project — the inputs write back into it — and
 * this component sends it up with every run as a context entry the tool reads
 * back. That is what makes a second instruction amend the first rather than
 * start again, and it is why a value typed into the card by hand survives the
 * next run.
 */

/** What `setProject` returns, as it arrives over AG-UI. */
type SetProjectResult = {
  a2ui_operations?: Array<Record<string, unknown>>;
  status?: string;
};

export function ProjectWizard({ today }: { today: string }) {
  return (
    // No `a2ui` prop on the provider: this page's surface never travels as a
    // CopilotKit activity, so the runtime has no reason to think A2UI is on
    // for it. The catalog goes to the renderer below instead.
    <CopilotKit credentials="include" runtimeUrl="/api/copilotkit">
      <A2UIProvider catalog={tutorCatalog}>
        <Wizard today={today} />
      </A2UIProvider>
    </CopilotKit>
  );
}

function Wizard({ today }: { today: string }) {
  const { agent, isReady } = useAgent({
    agentId: PROJECT_AGENT_ID,
    updates: [],
  });
  const { copilotkit } = useCopilotKit();
  const { processMessages, getSurface } = useA2UI();

  const [instruction, setInstruction] = useState("");
  const [status, setStatus] = useState("");
  const [running, setRunning] = useState(false);
  // Set by the subscriber, read after the run: a run that ended without a tool
  // call has left the card exactly as it was, and should say so.
  const painted = useRef(false);
  // The context entry carrying the card upwards. One at a time, replaced
  // before each run, so the agent is never handed a stale copy.
  const stateContext = useRef<string | undefined>(undefined);

  useEffect(() => {
    // What `@copilotkit/react-core` does for itself before drawing a surface in
    // the chat. Outside one nobody has done it, and without the stylesheet the
    // card renders as unstyled markup.
    initializeDefaultCatalog();
    injectStyles();
  }, []);

  useEffect(() => {
    // Until /info resolves, `agent` is a provisional stand-in that is later
    // swapped, taking any subscription on it along.
    if (!isReady) {
      return;
    }

    const subscription = agent.subscribe({
      onToolCallResultEvent: ({ event }) => {
        const result = parseToolResult(
          event.content,
        ) as SetProjectResult | null;
        if (!result?.a2ui_operations) {
          return;
        }
        // The operations are the card. Handing them straight to the renderer is
        // what makes this a surface rather than a component written for one
        // tool — see lib/project-card.ts for the tree they carry.
        processMessages(result.a2ui_operations);
        setStatus(result.status ?? "");
        painted.current = true;
      },
    });

    return () => subscription.unsubscribe();
  }, [agent, isReady, processMessages]);

  useEffect(
    () => () => {
      if (stateContext.current) {
        copilotkit.removeContext(stateContext.current);
      }
    },
    [copilotkit],
  );

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = instruction.trim();
    if (!text || !isReady || running) {
      return;
    }

    setRunning(true);
    setStatus("Planning…");
    setInstruction("");
    painted.current = false;

    // The card as it stands, which is the data model the inputs have been
    // writing into. No surface yet means no card yet, and the tool takes that
    // as its cue to create one.
    const card = getSurface(PROJECT_SURFACE_ID) as
      | { dataModel: { get(path: string): unknown } }
      | undefined;
    if (stateContext.current) {
      copilotkit.removeContext(stateContext.current);
      stateContext.current = undefined;
    }
    if (card) {
      stateContext.current = copilotkit.addContext({
        description: PROJECT_STATE_DESCRIPTION,
        value: JSON.stringify(card.dataModel.get("/")),
        // The tutor shares this runtime and has no use for a project card.
        agentIds: [PROJECT_AGENT_ID],
      });
    }

    // One message, replacing whatever the last submit left: the agent has no
    // memory of its own, and everything it needs to build on is in the context
    // entry above rather than in a transcript.
    agent.setMessages([
      { id: crypto.randomUUID(), role: "user", content: text },
    ]);

    try {
      await copilotkit.runAgent({ agent });
      if (!painted.current) {
        setStatus("The planner did not change the card.");
      }
    } catch {
      setStatus("The planner could not be reached. Try again.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
      <section className="flex-1 overflow-y-auto border border-edge bg-surface">
        <div className="border-b border-edge px-3 py-2">
          <h1 className="text-xl font-semibold text-ink">Project card</h1>
          <p className="text-sm text-ink-mute">Planning as of {today}.</p>
        </div>
        <div className="px-3 py-2">
          <A2UIRenderer
            fallback={
              <p className="text-sm text-ink-soft">
                Nothing planned yet. Describe the project below.
              </p>
            }
            surfaceId={PROJECT_SURFACE_ID}
          />
        </div>
      </section>

      <form className="flex items-end gap-2" onSubmit={onSubmit}>
        <div className="flex-1">
          <Field
            autoComplete="off"
            className="w-full"
            id="instruction"
            label="Instruction"
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="Plan a six month website relaunch"
            value={instruction}
          />
        </div>
        <Button disabled={running || !isReady} type="submit">
          Send
        </Button>
      </form>
      <p aria-live="polite" className="min-h-5 text-sm text-ink-soft">
        {status}
      </p>
    </div>
  );
}
