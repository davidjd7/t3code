import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useRouter } from "@tanstack/react-router";
import type { DesktopAppActivationRequest, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

import { handleDesktopAppActivationRequest } from "../../desktopAppActivation";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { findProjectByPath, inferProjectTitleFromPath } from "../../lib/projectPaths";
import { newProjectId } from "../../lib/utils";
import { readProjects, readThreadShell, waitForProject } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../../threadRoutes";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";

export function DesktopAppActivationCoordinator() {
  const primaryEnvironment = usePrimaryEnvironment();
  const { isReady, environments } = useEnvironments();
  const router = useRouter();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const openThread = useNewThreadHandler();
  const queueRef = useRef(Promise.resolve());
  const activation = window.desktopBridge?.appActivation;
  // Renderer readiness is independent of the primary local server: a connected
  // remote environment must remain addressable when the local server is down.
  const ready = activation !== undefined && isReady;
  const isEnvironmentReady = (environmentId: EnvironmentId) => {
    const environment = environments.find((entry) => entry.environmentId === environmentId);
    const shell = appAtomRegistry.get(environmentShell.stateValueAtom(environmentId));
    return (
      environment?.connection.phase === "connected" &&
      environment.serverConfig !== null &&
      shell.status === "live" &&
      shell.snapshot._tag === "Some"
    );
  };

  const processRequest = useEffectEvent(async (request: DesktopAppActivationRequest) =>
    handleDesktopAppActivationRequest(request, {
      isEnvironmentReady,
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
      getTarget: () => {
        if (
          primaryEnvironment === null ||
          primaryEnvironment.serverConfig === null ||
          !isEnvironmentReady(primaryEnvironment.environmentId)
        ) {
          return null;
        }
        return {
          environmentId: primaryEnvironment.environmentId,
          platform: primaryEnvironment.serverConfig.environment.platform.os,
        };
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

    let subscribed = true;
    const unsubscribe = activation.onRequest((request) => {
      queueRef.current = queueRef.current.then(async () => {
        const response = await processRequest(request);
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
      void activation.setReady(false).catch(() => undefined);
      unsubscribe();
    };
  }, [activation, ready]);

  return null;
}
