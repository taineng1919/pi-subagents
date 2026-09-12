/**
 * workflow-rpc-notify.test.ts — the progress Paseo reads off the RPC channel.
 *
 * Paseo renders a Pi extension's `ui.notify` frames as in-thread timeline
 * items, which is the only live surface a background workflow has outside the
 * terminal: the tool returns immediately and its inline card only exists in the
 * TUI. The transition stream itself is unit-tested in workflow-progress.test.ts;
 * what needs the real extension is the wiring — that the run reaches
 * `ctx.ui.notify`, in the card's vocabulary, and only on the RPC channel.
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
const fakeSession = () => ({
  dispose: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
  messages: [],
  getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
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

  it("announces each agent's transitions in the card's vocabulary", async () => {
    const booted = makePi();
    subagentsExtension(booted.pi);
    const context = ctx({ cwd: hermetic.dir, mode: "rpc" });

    await booted.tools.get("SubagentWorkflow").execute("tc-0", { script }, undefined, undefined, context);
    // The run is background; wait for both children to settle rather than for
    // the tool call, which returned before either had started.
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(notifications(context).at(-1)?.[0]).toContain("✔ reviewer"));

    const messages = notifications(context).map(([message]) => message);
    expect(messages).toContain("release-check · ⟳ execution running");
    expect(messages).toContain("release-check · ⟳ reviewer running");
    expect(messages.filter(message => message === "release-check · ⟳ execution running")).toHaveLength(1);
    expect(notifications(context).find(([message]) => message.startsWith("release-check · ✔ execution"))?.[1]).toBe("info");
  });

  it("raises failures, and does not repeat a notice the log re-emits", async () => {
    vi.mocked(runAgent).mockRejectedValueOnce(new Error("child exploded"));
    const booted = makePi();
    subagentsExtension(booted.pi);
    const context = ctx({ cwd: hermetic.dir, mode: "rpc" });

    await booted.tools.get("SubagentWorkflow").execute("tc-1", { script }, undefined, undefined, context);
    await vi.waitFor(() =>
      expect(notifications(context).some(([message, level]) => message.includes("✘ execution") && level === "error")).toBe(true),
    );
    await vi.waitFor(() => expect(notifications(context).some(([message]) => message.includes("✔ reviewer"))).toBe(true));

    const failures = notifications(context).filter(([, level]) => level === "error");
    expect(failures).toHaveLength(1);
    expect(failures[0][0]).toContain("child exploded");
  });

  it("stays quiet in the TUI, where the inline card already draws the same log", async () => {
    const booted = makePi();
    subagentsExtension(booted.pi);
    const context = ctx({ cwd: hermetic.dir });

    await booted.tools.get("SubagentWorkflow").execute("tc-2", { script }, undefined, undefined, context);
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));
    await flush();

    expect(context.ui.notify).not.toHaveBeenCalled();
  });
});
