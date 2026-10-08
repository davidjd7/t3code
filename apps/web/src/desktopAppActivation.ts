import type {
  DesktopAppActivationFailure,
  DesktopAppActivationPlatform,
  DesktopAppActivationRequest,
  DesktopAppActivationResponse,
  EnvironmentId,
  ExecutionEnvironmentPlatformOs,
  ProjectId,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";

export interface DesktopAppActivationProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}

export interface DesktopAppActivationTarget {
  readonly environmentId: EnvironmentId;
  readonly platform: ExecutionEnvironmentPlatformOs;
}

/**
 * The longest the renderer waits for a cold-starting environment before it
 * answers. The request's `deadlineAt`, forwarded by the desktop broker from
 * the CLI request, shortens it further: time spent before the renderer was
 * ready or queued behind another request is already gone.
 */
export const DESKTOP_APP_ACTIVATION_READINESS_TIMEOUT_MS = 8_000;

/** What remains of a request's time for one readiness wait. */
export interface DesktopAppActivationBudget {
  readonly timeoutMs: number;
  /** Aborted at the request deadline or when the renderer stops handling activations. */
  readonly signal: AbortSignal;
}

/** A synchronous, always-fresh value plus change notifications. */
export interface DesktopAppActivationReadinessSource<A> {
  readonly read: () => A | null;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * Resolves with the first non-null value of `source`, or `null` once
 * `timeoutMs` elapses or `signal` aborts. Every check reads the source again,
 * so a value observed before the wait started can never satisfy it later.
 */
export function waitForDesktopAppActivationReadiness<A>(
  source: DesktopAppActivationReadinessSource<A>,
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal | undefined },
): Promise<A | null> {
  if (options.signal?.aborted) return Promise.resolve(null);
  const initial = source.read();
  if (initial !== null) return Promise.resolve(initial);

  return new Promise<A | null>((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const finish = (value: A | null) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeoutId);
      options.signal?.removeEventListener("abort", onAbort);
      unsubscribe?.();
      resolve(value);
    };
    const check = () => {
      if (options.signal?.aborted) {
        finish(null);
        return;
      }
      const value = source.read();
      if (value !== null) finish(value);
    };
    const onAbort = () => finish(null);
    const timeoutId = globalThis.setTimeout(() => finish(null), options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const release = source.subscribe(check);
    if (settled) {
      release();
      return;
    }
    unsubscribe = release;
    // Close the gap between the initial read and subscription registration.
    check();
  });
}

export interface DesktopAppActivationDependencies {
  /** Waits, within `budget`, for the environment to be connected and synchronized. */
  readonly waitForEnvironmentReady: (
    environmentId: EnvironmentId,
    budget: DesktopAppActivationBudget,
  ) => Promise<boolean>;
  readonly findThread: (threadRef: ScopedThreadRef) => { readonly projectId: ProjectId } | null;
  readonly navigateToThread: (threadRef: ScopedThreadRef) => Promise<ScopedThreadRef | null>;
  /** Waits, within `budget`, for the primary local environment. */
  readonly waitForTarget: (
    budget: DesktopAppActivationBudget,
  ) => Promise<DesktopAppActivationTarget | null>;
  readonly findProject: (
    environmentId: EnvironmentId,
    workspaceRoot: string,
  ) => DesktopAppActivationProject | null;
  readonly createProject: (
    environmentId: EnvironmentId,
    workspaceRoot: string,
  ) => Promise<ProjectId>;
  readonly waitForProject: (projectRef: ScopedProjectRef) => Promise<void>;
  readonly openThread: (
    projectRef: ScopedProjectRef,
  ) => Promise<{ readonly threadId: ThreadId } | null>;
  /** Aborted when the renderer stops handling activations; no side effect may start after it. */
  readonly signal?: AbortSignal | undefined;
  /** Wall clock shared with the desktop broker's `deadlineAt`. */
  readonly now?: (() => number) | undefined;
}

function failure(
  requestId: string,
  code: DesktopAppActivationFailure["code"],
  message: string,
): DesktopAppActivationFailure {
  return { version: 1, requestId, ok: false, code, message };
}

function cancelled(requestId: string): DesktopAppActivationFailure {
  return failure(
    requestId,
    "renderer-unavailable",
    "T3 Code stopped handling the request before it could open it.",
  );
}

function timedOut(requestId: string): DesktopAppActivationFailure {
  return failure(
    requestId,
    "request-timeout",
    "The request expired before T3 Code could open it, so nothing was opened.",
  );
}

interface RequestScope {
  readonly budget: () => DesktopAppActivationBudget;
  /** The failure to answer with if no new side effect may start, otherwise null. */
  readonly interruption: () => DesktopAppActivationFailure | null;
  readonly dispose: () => void;
}

function openRequestScope(
  request: DesktopAppActivationRequest,
  dependencies: DesktopAppActivationDependencies,
): RequestScope {
  const now = dependencies.now ?? Date.now;
  const { deadlineAt } = request;
  const parent = dependencies.signal;
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  const deadlineTimer =
    deadlineAt === undefined
      ? undefined
      : globalThis.setTimeout(abort, Math.max(0, deadlineAt - now()));

  return {
    budget: () => ({
      timeoutMs: Math.max(
        0,
        Math.min(
          DESKTOP_APP_ACTIVATION_READINESS_TIMEOUT_MS,
          deadlineAt === undefined ? Number.POSITIVE_INFINITY : deadlineAt - now(),
        ),
      ),
      signal: controller.signal,
    }),
    interruption: () => {
      if (parent?.aborted) return cancelled(request.requestId);
      if (controller.signal.aborted || (deadlineAt !== undefined && now() >= deadlineAt)) {
        return timedOut(request.requestId);
      }
      return null;
    },
    dispose: () => {
      if (deadlineTimer !== undefined) globalThis.clearTimeout(deadlineTimer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

function desktopPlatformToEnvironmentOs(
  platform: DesktopAppActivationPlatform,
): ExecutionEnvironmentPlatformOs {
  return platform === "win32" ? "windows" : platform;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export async function handleDesktopAppActivationRequest(
  request: DesktopAppActivationRequest,
  dependencies: DesktopAppActivationDependencies,
): Promise<DesktopAppActivationResponse> {
  const scope = openRequestScope(request, dependencies);
  try {
    return await handleWithinScope(request, dependencies, scope);
  } finally {
    scope.dispose();
  }
}

async function handleWithinScope(
  request: DesktopAppActivationRequest,
  dependencies: DesktopAppActivationDependencies,
  scope: RequestScope,
): Promise<DesktopAppActivationResponse> {
  // A request that expired while waiting for the renderer or queued behind
  // another one must not start anything.
  const expired = scope.interruption();
  if (expired !== null) return expired;

  if (request.type === "open-thread") {
    const threadRef = { environmentId: request.environmentId, threadId: request.threadId };
    const environmentReady = await dependencies.waitForEnvironmentReady(
      threadRef.environmentId,
      scope.budget(),
    );
    const interrupted = scope.interruption();
    if (interrupted !== null) return interrupted;
    if (!environmentReady) {
      return failure(
        request.requestId,
        "environment-unavailable",
        "The requested environment is not connected and synchronized.",
      );
    }
    const thread = dependencies.findThread(threadRef);
    if (thread === null) {
      return failure(
        request.requestId,
        "thread-not-found",
        "The requested thread does not exist in this environment.",
      );
    }
    try {
      const opened = await dependencies.navigateToThread(threadRef);
      if (
        opened?.environmentId !== threadRef.environmentId ||
        opened.threadId !== threadRef.threadId
      ) {
        return failure(
          request.requestId,
          "thread-open-failed",
          "T3 Code did not navigate to the requested thread.",
        );
      }
      return {
        version: 1,
        requestId: request.requestId,
        ok: true,
        ...threadRef,
        projectId: thread.projectId,
      };
    } catch (error) {
      return failure(
        request.requestId,
        "thread-open-failed",
        errorMessage(error, "T3 Code could not open the requested thread."),
      );
    }
  }

  const target = await dependencies.waitForTarget(scope.budget());
  const interrupted = scope.interruption();
  if (interrupted !== null) return interrupted;
  if (target === null) {
    return failure(
      request.requestId,
      "environment-unavailable",
      "The desktop app's primary local environment is not connected.",
    );
  }

  const requestPlatform = desktopPlatformToEnvironmentOs(request.platform);
  if (requestPlatform !== target.platform) {
    return failure(
      request.requestId,
      "platform-mismatch",
      `The command path is for ${requestPlatform}, but the desktop app's primary environment uses ${target.platform}. Cross-platform path mapping is not supported.`,
    );
  }

  let projectId = dependencies.findProject(target.environmentId, request.workspaceRoot)?.id ?? null;
  if (projectId === null) {
    try {
      projectId = await dependencies.createProject(target.environmentId, request.workspaceRoot);
      await dependencies.waitForProject({ environmentId: target.environmentId, projectId });
    } catch (error) {
      return failure(
        request.requestId,
        "project-create-failed",
        errorMessage(error, "T3 Code could not add the project."),
      );
    }
  }

  const interruptedBeforeOpen = scope.interruption();
  if (interruptedBeforeOpen !== null) return interruptedBeforeOpen;
  try {
    const opened = await dependencies.openThread({
      environmentId: target.environmentId,
      projectId,
    });
    if (opened === null) {
      return failure(
        request.requestId,
        "thread-open-failed",
        "T3 Code could not open a new thread for the project.",
      );
    }
    return {
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId,
      threadId: opened.threadId,
    };
  } catch (error) {
    return failure(
      request.requestId,
      "thread-open-failed",
      errorMessage(error, "T3 Code could not open a new thread for the project."),
    );
  }
}
