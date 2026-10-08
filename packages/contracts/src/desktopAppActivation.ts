import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION = 1 as const;

export const DesktopAppActivationPlatform = Schema.Literals(["darwin", "linux", "win32"]);
export type DesktopAppActivationPlatform = typeof DesktopAppActivationPlatform.Type;

/**
 * Epoch milliseconds after which the requester no longer waits for an answer.
 * The desktop broker always forwards its own deadline to the renderer, never
 * later than one a client supplied, so no navigation starts after it elapses.
 * Optional so either side keeps working against a peer that predates it.
 */
const DesktopAppActivationDeadlineAt = Schema.optional(Schema.Finite);

export const DesktopAppOpenWorkspaceRequest = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  deadlineAt: DesktopAppActivationDeadlineAt,
  type: Schema.Literal("open-workspace"),
  workspaceRoot: TrimmedNonEmptyString,
  platform: DesktopAppActivationPlatform,
});
export const DesktopAppActivationRequest = Schema.Union([
  DesktopAppOpenWorkspaceRequest,
  Schema.Struct({
    version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
    requestId: TrimmedNonEmptyString,
    deadlineAt: DesktopAppActivationDeadlineAt,
    type: Schema.Literal("open-thread"),
    environmentId: EnvironmentId,
    threadId: ThreadId,
  }),
]);
export type DesktopAppActivationRequest = typeof DesktopAppActivationRequest.Type;

export const DesktopAppActivationErrorCode = Schema.Literals([
  "invalid-request",
  "renderer-unavailable",
  "environment-unavailable",
  "platform-mismatch",
  "project-create-failed",
  "thread-open-failed",
  "thread-not-found",
  "request-timeout",
  "internal-error",
]);
export type DesktopAppActivationErrorCode = typeof DesktopAppActivationErrorCode.Type;

export const DesktopAppActivationSuccess = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(true),
  environmentId: Schema.optional(EnvironmentId),
  projectId: ProjectId,
  threadId: ThreadId,
});
export type DesktopAppActivationSuccess = typeof DesktopAppActivationSuccess.Type;

export const DesktopAppActivationFailure = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(false),
  code: DesktopAppActivationErrorCode,
  message: TrimmedNonEmptyString,
});
export type DesktopAppActivationFailure = typeof DesktopAppActivationFailure.Type;

export const DesktopAppActivationResponse = Schema.Union([
  DesktopAppActivationSuccess,
  DesktopAppActivationFailure,
]);
export type DesktopAppActivationResponse = typeof DesktopAppActivationResponse.Type;
