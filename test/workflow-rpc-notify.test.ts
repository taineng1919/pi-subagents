/**
 * workflow-rpc-notify.test.ts — the progress Paseo reads off the RPC channel.
 *
 * Paseo renders a Pi extension's `ui.notify` frames as in-thread timeline
 * items, which is the only live surface a background workflow has outside the
 * terminal: the tool returns immediately and its inline card only exists in the
 * TUI. The transition stream itself is unit-tested in workflow-progress.test.ts;
 * what needs the real extension is the wiring — that the run reaches
 * `ctx.ui.notify`, in the card's vocabulary, only on the RPC channel, and that
 * a channel failure cannot take the run down with it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const script =
  'export const meta = { name: "release-check", description: "verify the release" };\n' +
  'await agent("review the diff", { label: "execution" });\n' +
  'await agent("verify the fix", { label: "reviewer" });\n';

/** Enough of a session for the manager to keep. */
const fakeSession = (overrides: Record<string, unknown> = {}) => ({
  dispose: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
  messages: [],
  getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
  ...overrides,
});

describe("workflow progress on the RPC channel", () => {
  let hermetic: Hermetic;

  beforeEach(() => {
    hermetic = hermeticDir({ settings: { workflowsEnabled: true } });
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: any, opts: any) => {
      opts.onSessionCreated?.(fakeSession() as any);
      return { responseText: "child done", session: fakeSession() as any, aborted: false, steered: false };
    });
  });
  afterEach(() => {
    vi.mocked(runAgent).mockReset();
    hermetic.restore();
  });

  const notifications = (context: ReturnType<typeof ctx>): [string, string][] =>
    context.ui.notify.mock.calls.map(([message, level]: [string, string]) => [message, level]);
  const messages = (context: ReturnType<typeof ctx>): string[] =>
    notifications(context).map(([message]) => message);

  it("announces each agent's transitions in the card's vocabulary", async () => {
    const booted = makePi();
    subagentsExtension(booted.pi);
    const context = ctx({ cwd: hermetic.dir, mode: "rpc" });

    await booted.tools.get("SubagentWorkflow").execute("tc-0", { script }, undefined, undefined, context);
    // The run is background; wait for both children to settle rather than for
    // the tool call, which returned before either had started.
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(messages(context).at(-1)).toContain("✔ reviewer"));

    expect(messages(context)).toContainEqual(expect.stringMatching(/^release-check \[wf_\w+\] · ⟳ execution running$/));
    expect(messages(context)).toContainEqual(expect.stringMatching(/^release-check \[wf_\w+\] · ⟳ reviewer running$/));
    expect(messages(context).filter(message => message.endsWith("⟳ execution running"))).toHaveLength(1);
    expect(notifications(context).find(([message]) => message.includes("✔ execution"))?.[1]).toBe("info");
  });

  it("refreshes a running row with the effective model and effort, and carries effort into the settlement", async () => {
    const parentModel = { provider: "opencode-go", id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" };
    const fixedModel = { provider: "anthropic", id: "claude-sonnet-4-6", name: "Sonnet 4.6" };
    let call = 0;
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: any, opts: any) => {
      // First child inherits the parent's model; the second one the script
      // pinned. Both report the effort their session ended up at.
      const session =
        call++ === 0
          ? fakeSession({ model: parentModel, thinkingLevel: "max" })
          : fakeSession({ model: fixedModel, thinkingLevel: "high" });
      opts.onSessionCreated?.(session as any);
      return { responseText: "child done", session: session as any, aborted: false, steered: false };
    });
    const booted = makePi();
    subagentsExtension(booted.pi);
    const context = ctx({
      cwd: hermetic.dir,
      mode: "rpc",
      model: parentModel,
      modelRegistry: { find: vi.fn(() => fixedModel), getAvailable: vi.fn(() => [parentModel, fixedModel]) },
    });

    const phased =
      'export const meta = { name: "implement-review", description: "implement then review" };\n' +
      'phase("Implement");\n' +
      'const a = await agent("implement the change", { label: "execution" });\n' +
      'phase("Review");\n' +
      'const b = await agent("review the change", { label: "reviewer", model: "sonnet" });\n' +
      'return [a, b];\n';
    await booted.tools.get("SubagentWorkflow").execute("tc-1", { script: phased }, undefined, undefined, context);
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(messages(context).at(-1)).toContain("✔ reviewer"));

    // The resolution update is the one that says which effort is running —
    // and the phase keeps Implement's execution apart from Review's reviewer.
    expect(messages(context)).toContainEqual(
      expect.stringMatching(/^implement-review \[wf_\w+\] · Implement · ⟳ execution · general-purpose · deepseek v4\.1 flash · thinking: max$/),
    );
    expect(messages(context)).toContainEqual(
      expect.stringMatching(/^implement-review \[wf_\w+\] · Review · ⟳ reviewer · general-purpose · sonnet 4\.6 · thinking: high$/),
    );
    // The settlement keeps the effective effort, which `agentStatSegments`
    // alone would have dropped. Duration is not asserted: a mocked child can
    // settle within the same millisecond (omitted) or just past it (appended).
    expect(messages(context)).toContainEqual(
      expect.stringContaining("· Review · ✔ reviewer · general-purpose · sonnet 4.6 · thinking: high"),
    );
  });

  it("raises failures, and does not repeat a notice the log re-emits", async () => {
    vi.mocked(runAgent).mockRejectedValueOnce(new Error("child exploded"));
    const booted = makePi();
    subagentsExtension(booted.pi);
    const context = ctx({ cwd: hermetic.dir, mode: "rpc" });

    await booted.tools.get("SubagentWorkflow").execute("tc-2", { script }, undefined, undefined, context);
    await vi.waitFor(() =>
      expect(notifications(context).some(([message, level]) => message.includes("✘ execution") && level === "error")).toBe(true),
    );
    await vi.waitFor(() => expect(messages(context).some(message => message.includes("✔ reviewer"))).toBe(true));

    const failures = notifications(context).filter(([, level]) => level === "error");
    expect(failures).toHaveLength(1);
    expect(failures[0][0]).toContain("child exploded");
  });

  it("keeps the workflow alive when the notification channel throws", async () => {
    const booted = makePi();
    subagentsExtension(booted.pi);
    const context = ctx({
      cwd: hermetic.dir,
      mode: "rpc",
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn(() => {
          throw new Error("channel down");
        }),
        addAutocompleteProvider: vi.fn(),
      },
    });

    const result = await booted.tools.get("SubagentWorkflow").execute("tc-3", { script }, undefined, undefined, context);
    const taskId = (result.details as { taskId: string }).taskId;
    // The completion nudge is the run's own signal that it survived the
    // observer: it is only scheduled once both children have settled.
    await vi.waitFor(
      () =>
        expect(
          booted.pi.sendMessage.mock.calls.some((call: any[]) => String(call[0]?.content).includes(taskId)),
        ).toBe(true),
    );
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it("stays quiet in the TUI, where the inline card already draws the same log", async () => {
    const booted = makePi();
    subagentsExtension(booted.pi);
    const context = ctx({ cwd: hermetic.dir });

    await booted.tools.get("SubagentWorkflow").execute("tc-4", { script }, undefined, undefined, context);
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));
    await flush();

    expect(context.ui.notify).not.toHaveBeenCalled();
  });
});
