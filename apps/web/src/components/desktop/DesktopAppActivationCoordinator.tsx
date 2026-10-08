import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useRouter } from "@tanstack/react-router";
import type { DesktopAppActivationRequest, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useEffect, useEffectEvent, useRef } from "react";

import {
  handleDesktopAppActivationRequest,
  waitForDesktopAppActivationReadiness,
  type DesktopAppActivationReadinessSource,
  type DesktopAppActivationTarget,
} from "../../desktopAppActivation";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { findProjectByPath, inferProjectTitleFromPath } from "../../lib/projectPaths";
import { newProjectId } from "../../lib/utils";
import { readProjects, readThreadShell, waitForProject } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { environmentPresentations } from "../../state/presentation";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { projectEnvironment } from "../../state/projects";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../../threadRoutes";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";

/** Connected, configured, and holding a live shell snapshot: thread lookups are authoritative. */
const environmentActivationReadyAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const presentation = get(environmentPresentations.presentationAtom(environmentId));
    const shell = get(environmentShell.stateValueAtom(environmentId));
    return (
      presentation?.connection.phase === "connected" &&
      presentation.serverConfig !== null &&
      shell.status === "live" &&
      Option.isSome(shell.snapshot)
    );
  }).pipe(Atom.withLabel(`desktop-app-activation-ready:${environmentId}`)),
);

const primaryActivationTargetAtom = Atom.make((get): DesktopAppActivationTarget | null => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null || !get(environmentActivationReadyAtom(environmentId))) return null;
  const serverConfig = get(environmentPresentations.presentationAtom(environmentId))?.serverConfig;
  return serverConfig == null
    ? null
    : { environmentId, platform: serverConfig.environment.platform.os };
}).pipe(Atom.withLabel("desktop-app-activation-primary-target"));

/**
 * Reads straight from the registry rather than from render-time state, so a
 * wait that started while connecting sees the transition to ready. The
 * subscription also keeps the environment's shell stream mounted meanwhile.
 */
function registrySource<A, B>(
  atom: Atom.Atom<A>,
  select: (value: A) => B | null,
): DesktopAppActivationReadinessSource<B> {
  return {
    read: () => select(appAtomRegistry.get(atom)),
    subscribe: (listener) => appAtomRegistry.subscribe(atom, () => listener()),
  };
}

export function DesktopAppActivationCoordinator({
  primaryEnvironmentExpected,
}: {
  /** False when the desktop runs without its local server (remote connections only). */
  readonly primaryEnvironmentExpected: boolean;
}) {
  const { isReady } = useEnvironments();
  const router = useRouter();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const openThread = useNewThreadHandler();
  const queueRef = useRef(Promise.resolve());
  const activation = window.desktopBridge?.appActivation;
  // Renderer readiness is independent of every environment: requests wait,
  // within a bounded budget, for the specific environment they target.
  const ready = activation !== undefined && isReady;

  const processRequest = useEffectEvent(
    async (request: DesktopAppActivationRequest, signal: AbortSignal) =>
      handleDesktopAppActivationRequest(request, {
        signal,
        waitForEnvironmentReady: async (environmentId, budget) =>
          (await waitForDesktopAppActivationReadiness(
            registrySource(environmentActivationReadyAtom(environmentId), (environmentReady) =>
              environmentReady ? true : null,
            ),
            budget,
          )) === true,
        findThread: (threadRef) => {
          const thread = readThreadShell(threadRef);
          return thread === null || thread.deletedAt !== null
            ? null
            : { projectId: thread.projectId };
        },
        navigateToThread: async (threadRef) => {
          await router.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(threadRef),
          });
          return resolveThreadRouteRef(router.state.matches.at(-1)?.params ?? {});
        },
        waitForTarget: async (budget) => {
          // Without a local server there is no primary to wait for.
          if (!primaryEnvironmentExpected) return null;
          return waitForDesktopAppActivationReadiness(
            registrySource(primaryActivationTargetAtom, (target) => target),
            budget,
          );
        },
        findProject: (environmentId, workspaceRoot) =>
          findProjectByPath(
            readProjects().filter((project) => project.environmentId === environmentId),
            workspaceRoot,
          ) ?? null,
        createProject: async (environmentId, workspaceRoot) => {
          const projectId = newProjectId();
          const result = await createProject({
            environmentId,
            input: {
              projectId,
              title: inferProjectTitleFromPath(workspaceRoot),
              workspaceRoot,
              createWorkspaceRootIfMissing: false,
              defaultModelSelection: null,
            },
          });
          if (result._tag === "Failure") {
            const error = squashAtomCommandFailure(result);
            throw error instanceof Error ? error : new Error("T3 Code could not add the project.");
          }
          return projectId;
        },
        waitForProject: async (projectRef) => {
          await waitForProject(projectRef);
        },
        openThread: (projectRef) => openThread(projectRef),
      }),
  );

  useEffect(() => {
    if (!ready || activation === undefined) return;

    // Aborting stops pending readiness waits so no navigation starts after the
    // broker has dropped this renderer. Each request also carries the broker's
    // deadline, which bounds its readiness waits and its time in this queue.
    const controller = new AbortController();
    let subscribed = true;
    const unsubscribe = activation.onRequest((request) => {
      queueRef.current = queueRef.current.then(async () => {
        const response = await processRequest(request, controller.signal);
        await activation.complete(response);
      });
      queueRef.current = queueRef.current.catch(() => undefined);
    });
    // Skip readiness if React runs cleanup before this subscription can receive requests.
    queueMicrotask(() => {
      if (subscribed) void activation.setReady(true).catch(() => undefined);
    });
    return () => {
      subscribed = false;
      controller.abort();
      void activation.setReady(false).catch(() => undefined);
      unsubscribe();
    };
  }, [activation, ready]);

  return null;
}
