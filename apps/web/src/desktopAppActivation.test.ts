import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type DesktopAppActivationResponse,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  DESKTOP_APP_ACTIVATION_READINESS_TIMEOUT_MS,
  handleDesktopAppActivationRequest,
  waitForDesktopAppActivationReadiness,
  type DesktopAppActivationBudget,
  type DesktopAppActivationDependencies,
  type DesktopAppActivationReadinessSource,
  type DesktopAppActivationTarget,
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
    waitForEnvironmentReady: async () => true,
    findThread: () => ({ projectId: existingProjectId }),
    navigateToThread: vi.fn(async (ref) => ref),
    waitForTarget: async () => ({ environmentId, platform: "linux" }),
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
      dependencies({ waitForTarget: async () => ({ environmentId, platform: "linux" }) }),
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
      waitForTarget: vi.fn(async () => null), // No local primary server is required.
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
    expect(deps.waitForTarget).not.toHaveBeenCalled();
    expect(deps.createProject).not.toHaveBeenCalled();
    expect(deps.openThread).not.toHaveBeenCalled();
  });

  it.each(["offline", "missing"] as const)(
    "does not navigate or create for an %s target",
    async (kind) => {
      const deps = dependencies({
        waitForEnvironmentReady: async () => kind !== "offline",
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

/** A mutable value standing in for registry atoms; `set` notifies subscribers. */
function mutableSource<A>(initial: A | null) {
  let value = initial;
  const listeners = new Set<() => void>();
  const source: DesktopAppActivationReadinessSource<A> = {
    read: vi.fn(() => value),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    listenerCount: () => listeners.size,
    set(next: A | null) {
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

describe("desktop activation readiness wait", () => {
  it("resolves immediately with a value that is already ready", async () => {
    const ready = mutableSource(true);
    expect(await waitForDesktopAppActivationReadiness(ready.source, { timeoutMs: 1_000 })).toBe(
      true,
    );
    expect(ready.listenerCount()).toBe(0);
  });

  it("follows a connecting environment until it becomes ready", async () => {
    vi.useFakeTimers();
    try {
      const environment = mutableSource<true>(null);
      const wait = waitForDesktopAppActivationReadiness(environment.source, {
        timeoutMs: DESKTOP_APP_ACTIVATION_READINESS_TIMEOUT_MS,
      });
      await vi.advanceTimersByTimeAsync(3_000);
      environment.set(null); // Still synchronizing: not enough.
      await vi.advanceTimersByTimeAsync(1_000);
      environment.set(true);
      expect(await wait).toBe(true);
      expect(environment.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up at the deadline and ignores a later transition", async () => {
    vi.useFakeTimers();
    try {
      const environment = mutableSource<true>(null);
      const wait = waitForDesktopAppActivationReadiness(environment.source, {
        timeoutMs: DESKTOP_APP_ACTIVATION_READINESS_TIMEOUT_MS,
      });
      await vi.advanceTimersByTimeAsync(DESKTOP_APP_ACTIVATION_READINESS_TIMEOUT_MS);
      expect(await wait).toBeNull();
      expect(environment.listenerCount()).toBe(0);
      environment.set(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting as soon as the renderer aborts", async () => {
    const environment = mutableSource<true>(null);
    const controller = new AbortController();
    const wait = waitForDesktopAppActivationReadiness(environment.source, {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    controller.abort();
    expect(await wait).toBeNull();
    expect(environment.listenerCount()).toBe(0);
  });

  it("keeps the readiness budget under the desktop broker timeout", () => {
    expect(DESKTOP_APP_ACTIVATION_READINESS_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});

describe("desktop activation during an environment cold start", () => {
  const remoteId = EnvironmentId.make("remote");
  const openRequest = {
    version: 1,
    requestId: "cold-start",
    type: "open-thread",
    environmentId: remoteId,
    threadId,
  } as const;

  function waitingOn<A>(source: DesktopAppActivationReadinessSource<A>, signal?: AbortSignal) {
    return () =>
      waitForDesktopAppActivationReadiness(source, {
        timeoutMs: DESKTOP_APP_ACTIVATION_READINESS_TIMEOUT_MS,
        signal,
      });
  }

  it("opens the thread once a connecting remote environment becomes ready", async () => {
    vi.useFakeTimers();
    try {
      const environment = mutableSource<true>(null);
      const wait = waitingOn(environment.source);
      const deps = dependencies({
        waitForEnvironmentReady: async () => (await wait()) === true,
      });
      const response = handleDesktopAppActivationRequest(openRequest, deps);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(deps.navigateToThread).not.toHaveBeenCalled();
      environment.set(true);
      expect(await response).toMatchObject({ ok: true, environmentId: remoteId, threadId });
      expect(deps.navigateToThread).toHaveBeenCalledWith({ environmentId: remoteId, threadId });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails at the deadline without a late navigation", async () => {
    vi.useFakeTimers();
    try {
      const environment = mutableSource<true>(null);
      const wait = waitingOn(environment.source);
      const deps = dependencies({
        waitForEnvironmentReady: async () => (await wait()) === true,
      });
      const response = handleDesktopAppActivationRequest(openRequest, deps);
      await vi.advanceTimersByTimeAsync(DESKTOP_APP_ACTIVATION_READINESS_TIMEOUT_MS);
      expect(await response).toMatchObject({ ok: false, code: "environment-unavailable" });
      environment.set(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(deps.navigateToThread).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not navigate after the renderer stops handling activations", async () => {
    const environment = mutableSource<true>(null);
    const controller = new AbortController();
    const wait = waitingOn(environment.source, controller.signal);
    const deps = dependencies({
      signal: controller.signal,
      waitForEnvironmentReady: async () => (await wait()) === true,
    });
    const response = handleDesktopAppActivationRequest(openRequest, deps);
    controller.abort();
    environment.set(true);
    expect(await response).toMatchObject({ ok: false, code: "renderer-unavailable" });
    expect(deps.navigateToThread).not.toHaveBeenCalled();
  });

  it("waits for the primary environment before opening a workspace", async () => {
    vi.useFakeTimers();
    try {
      const primary = mutableSource<DesktopAppActivationTarget>(null);
      const deps = dependencies({ waitForTarget: waitingOn(primary.source) });
      const response = handleDesktopAppActivationRequest(request, deps);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(deps.openThread).not.toHaveBeenCalled();
      primary.set({ environmentId, platform: "linux" });
      expect(await response).toMatchObject({ ok: true, projectId: existingProjectId, threadId });
      expect(deps.openThread).toHaveBeenCalledWith({ environmentId, projectId: existingProjectId });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a workspace request when the primary never becomes ready", async () => {
    vi.useFakeTimers();
    try {
      const primary = mutableSource<DesktopAppActivationTarget>(null);
      const deps = dependencies({ waitForTarget: waitingOn(primary.source) });
      const response = handleDesktopAppActivationRequest(request, deps);
      await vi.advanceTimersByTimeAsync(DESKTOP_APP_ACTIVATION_READINESS_TIMEOUT_MS);
      expect(await response).toMatchObject({ ok: false, code: "environment-unavailable" });
      expect(deps.createProject).not.toHaveBeenCalled();
      expect(deps.openThread).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not create a project after the renderer stops handling activations", async () => {
    const primary = mutableSource<DesktopAppActivationTarget>(null);
    const controller = new AbortController();
    const deps = dependencies({
      signal: controller.signal,
      findProject: () => null,
      waitForTarget: waitingOn(primary.source, controller.signal),
    });
    const response = handleDesktopAppActivationRequest(request, deps);
    controller.abort();
    expect(await response).toMatchObject({ ok: false, code: "renderer-unavailable" });
    expect(deps.createProject).not.toHaveBeenCalled();
    expect(deps.openThread).not.toHaveBeenCalled();
  });
});

describe("desktop activation request deadline", () => {
  const remoteId = EnvironmentId.make("remote");
  const openRequest = {
    version: 1,
    requestId: "deadline",
    type: "open-thread",
    environmentId: remoteId,
    threadId,
  } as const;

  /** Waits with whatever budget the handler grants, like the coordinator does. */
  function budgeted<A>(source: DesktopAppActivationReadinessSource<A>) {
    return vi.fn((budget: DesktopAppActivationBudget) =>
      waitForDesktopAppActivationReadiness(source, budget),
    );
  }

  it("refuses a request whose deadline passed before the renderer handled it", async () => {
    vi.useFakeTimers();
    try {
      const waitForEnvironmentReady = vi.fn(async () => true);
      const deps = dependencies({ waitForEnvironmentReady });
      const response = await handleDesktopAppActivationRequest(
        { ...openRequest, deadlineAt: Date.now() - 1 },
        deps,
      );
      expect(response).toMatchObject({ ok: false, code: "request-timeout" });
      expect(waitForEnvironmentReady).not.toHaveBeenCalled();
      expect(deps.navigateToThread).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds readiness by the time left and never navigates after the deadline", async () => {
    vi.useFakeTimers();
    try {
      const environment = mutableSource<true>(null);
      const wait = budgeted(environment.source);
      const deps = dependencies({
        waitForEnvironmentReady: async (_environmentId, budget) => (await wait(budget)) === true,
      });
      const response = handleDesktopAppActivationRequest(
        { ...openRequest, deadlineAt: Date.now() + 3_000 },
        deps,
      );
      expect(wait.mock.calls[0]?.[0].timeoutMs).toBe(3_000);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await response).toMatchObject({ ok: false, code: "request-timeout" });
      environment.set(true);
      await vi.advanceTimersByTimeAsync(DESKTOP_APP_ACTIVATION_READINESS_TIMEOUT_MS);
      expect(deps.navigateToThread).not.toHaveBeenCalled();
      expect(deps.openThread).not.toHaveBeenCalled();
      expect(environment.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps readiness at its own budget when the deadline is further away", async () => {
    vi.useFakeTimers();
    try {
      const waitForEnvironmentReady = vi.fn(async () => true);
      const response = await handleDesktopAppActivationRequest(
        { ...openRequest, deadlineAt: Date.now() + 60_000 },
        dependencies({ waitForEnvironmentReady }),
      );
      expect(response).toMatchObject({ ok: true });
      expect(waitForEnvironmentReady).toHaveBeenCalledWith(
        remoteId,
        expect.objectContaining({ timeoutMs: DESKTOP_APP_ACTIVATION_READINESS_TIMEOUT_MS }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers a queued request with a timeout once the request ahead outlived its deadline", async () => {
    vi.useFakeTimers();
    try {
      // The renderer serializes requests like the coordinator's queue.
      let queue = Promise.resolve();
      const enqueue = (run: () => Promise<DesktopAppActivationResponse>) => {
        const result = queue.then(run);
        queue = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      };
      let releaseFirst!: () => void;
      const firstNavigation = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const first = dependencies({
        navigateToThread: vi.fn(async (ref) => {
          await firstNavigation;
          return ref;
        }),
      });
      const second = dependencies();

      // The broker stamps the deadline when the request arrives, not when it is dequeued.
      const queuedRequest = { ...openRequest, requestId: "queued", deadlineAt: Date.now() + 2_000 };
      const firstResponse = enqueue(() => handleDesktopAppActivationRequest(openRequest, first));
      const secondResponse = enqueue(() =>
        handleDesktopAppActivationRequest(queuedRequest, second),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      releaseFirst();

      expect(await firstResponse).toMatchObject({ ok: true });
      expect(await secondResponse).toMatchObject({ ok: false, code: "request-timeout" });
      expect(second.navigateToThread).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not open a thread for a workspace whose deadline passed during project creation", async () => {
    vi.useFakeTimers();
    try {
      const deps = dependencies({
        findProject: () => null,
        waitForProject: vi.fn(
          () => new Promise<void>((resolve) => globalThis.setTimeout(resolve, 5_000)),
        ),
      });
      const response = handleDesktopAppActivationRequest(
        { ...request, deadlineAt: Date.now() + 2_000 },
        deps,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await response).toMatchObject({ ok: false, code: "request-timeout" });
      expect(deps.createProject).toHaveBeenCalledOnce();
      expect(deps.openThread).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still reports a renderer cancellation as such before the deadline", async () => {
    const controller = new AbortController();
    const environment = mutableSource<true>(null);
    const deps = dependencies({
      signal: controller.signal,
      waitForEnvironmentReady: async (_environmentId, budget) =>
        (await waitForDesktopAppActivationReadiness(environment.source, budget)) === true,
    });
    const response = handleDesktopAppActivationRequest(
      { ...openRequest, deadlineAt: Date.now() + 60_000 },
      deps,
    );
    controller.abort();
    expect(await response).toMatchObject({ ok: false, code: "renderer-unavailable" });
    expect(deps.navigateToThread).not.toHaveBeenCalled();
  });
});
