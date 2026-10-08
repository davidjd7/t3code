import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  handleDesktopAppActivationRequest,
  type DesktopAppActivationDependencies,
} from "./desktopAppActivation";

const environmentId = EnvironmentId.make("primary");
const existingProjectId = ProjectId.make("project-existing");
const createdProjectId = ProjectId.make("project-created");
const threadId = ThreadId.make("thread-1");
const request = {
  version: 1,
  requestId: "request-1",
  type: "open-workspace",
  workspaceRoot: "/workspace/project",
  platform: "linux",
} as const;

function dependencies(
  overrides: Partial<DesktopAppActivationDependencies> = {},
): DesktopAppActivationDependencies {
  return {
    isEnvironmentReady: () => true,
    findThread: () => ({ projectId: existingProjectId }),
    navigateToThread: vi.fn(async (ref) => ref),
    getTarget: () => ({ environmentId, platform: "linux" }),
    findProject: () => ({
      id: existingProjectId,
      environmentId,
      workspaceRoot: request.workspaceRoot,
    }),
    createProject: vi.fn(async () => createdProjectId),
    waitForProject: vi.fn(async () => undefined),
    openThread: vi.fn(async () => ({ threadId })),
    ...overrides,
  };
}

describe("desktop app activation", () => {
  it("reuses an existing project and opens a new thread", async () => {
    const deps = dependencies();

    const response = await handleDesktopAppActivationRequest(request, deps);

    expect(deps.createProject).not.toHaveBeenCalled();
    expect(deps.openThread).toHaveBeenCalledWith({ environmentId, projectId: existingProjectId });
    expect(response).toEqual({
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId: existingProjectId,
      threadId,
    });
  });

  it("waits for a created project before it opens the thread", async () => {
    const order: string[] = [];
    const deps = dependencies({
      findProject: () => null,
      createProject: vi.fn(async () => {
        order.push("create");
        return createdProjectId;
      }),
      waitForProject: vi.fn(async () => {
        order.push("project-event");
      }),
      openThread: vi.fn(async () => {
        order.push("open-thread");
        return { threadId };
      }),
    });

    const response = await handleDesktopAppActivationRequest(request, deps);

    expect(order).toEqual(["create", "project-event", "open-thread"]);
    expect(response).toMatchObject({ ok: true, projectId: createdProjectId });
  });

  it("rejects a Windows path when the primary environment is WSL", async () => {
    const response = await handleDesktopAppActivationRequest(
      { ...request, platform: "win32" },
      dependencies({ getTarget: () => ({ environmentId, platform: "linux" }) }),
    );

    expect(response).toMatchObject({ ok: false, code: "platform-mismatch" });
  });

  it("returns a project error without opening a thread", async () => {
    const openThread = vi.fn(async () => ({ threadId }));
    const response = await handleDesktopAppActivationRequest(
      request,
      dependencies({
        findProject: () => null,
        createProject: vi.fn(async () => {
          throw new Error("Project path is not available.");
        }),
        openThread,
      }),
    );

    expect(response).toMatchObject({
      ok: false,
      code: "project-create-failed",
      message: "Project path is not available.",
    });
    expect(openThread).not.toHaveBeenCalled();
  });
});

describe("desktop activation of an existing thread", () => {
  const remoteId = EnvironmentId.make("remote");
  const openRequest = {
    version: 1,
    requestId: "open-existing",
    type: "open-thread",
    environmentId: remoteId,
    threadId,
  } as const;

  it("selects the exact environment and thread even with duplicate IDs, without creating anything", async () => {
    const records = [
      { environmentId, threadId, projectId: createdProjectId, title: "Same title" },
      { environmentId: remoteId, threadId, projectId: existingProjectId, title: "Same title" },
    ];
    const deps = dependencies({
      getTarget: vi.fn(() => null), // No local primary server is required.
      findThread: (ref) =>
        records.find(
          (row) => row.environmentId === ref.environmentId && row.threadId === ref.threadId,
        ) ?? null,
    });
    const response = await handleDesktopAppActivationRequest(openRequest, deps);
    expect(response).toEqual({
      version: 1,
      requestId: openRequest.requestId,
      ok: true,
      environmentId: remoteId,
      threadId,
      projectId: existingProjectId,
    });
    expect(deps.navigateToThread).toHaveBeenCalledWith({ environmentId: remoteId, threadId });
    expect(deps.getTarget).not.toHaveBeenCalled();
    expect(deps.createProject).not.toHaveBeenCalled();
    expect(deps.openThread).not.toHaveBeenCalled();
  });

  it.each(["offline", "missing"] as const)(
    "does not navigate or create for an %s target",
    async (kind) => {
      const deps = dependencies({
        isEnvironmentReady: () => kind !== "offline",
        findThread: () => null,
      });
      expect(await handleDesktopAppActivationRequest(openRequest, deps)).toMatchObject({
        ok: false,
        code: kind === "offline" ? "environment-unavailable" : "thread-not-found",
      });
      expect(deps.navigateToThread).not.toHaveBeenCalled();
      expect(deps.createProject).not.toHaveBeenCalled();
      expect(deps.openThread).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    { environmentId, threadId },
    { environmentId: remoteId, threadId: ThreadId.make("wrong-thread") },
  ])("rejects a navigation which ended on another route (%j)", async (opened) => {
    const deps = dependencies({ navigateToThread: async () => opened });
    expect(await handleDesktopAppActivationRequest(openRequest, deps)).toMatchObject({
      ok: false,
      code: "thread-open-failed",
    });
  });

  it("does not acknowledge success before navigation completes", async () => {
    let complete!: (value: { environmentId: typeof remoteId; threadId: typeof threadId }) => void;
    const navigation = new Promise<{ environmentId: typeof remoteId; threadId: typeof threadId }>(
      (resolve) => {
        complete = resolve;
      },
    );
    const deps = dependencies({ navigateToThread: () => navigation });
    let acknowledged = false;
    const response = handleDesktopAppActivationRequest(openRequest, deps).then((result) => {
      acknowledged = true;
      return result;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    complete({ environmentId: remoteId, threadId });
    expect(await response).toMatchObject({ ok: true });
  });

  it("returns a failure if navigation throws", async () => {
    const deps = dependencies({
      navigateToThread: async () => {
        throw new Error("Navigation failed");
      },
    });
    expect(await handleDesktopAppActivationRequest(openRequest, deps)).toMatchObject({
      ok: false,
      code: "thread-open-failed",
      message: "Navigation failed",
    });
  });
});
