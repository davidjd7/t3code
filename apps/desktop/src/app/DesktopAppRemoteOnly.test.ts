import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as DesktopWindow from "../window/DesktopWindow.ts";
import { bootstrapRemoteOnly } from "./DesktopApp.ts";
import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import * as DesktopState from "./DesktopState.ts";

function makeLayer(input: {
  readonly events: Array<string>;
  readonly quitting?: boolean;
  readonly startFails?: boolean;
}) {
  const record = (event: string) => Effect.sync(() => void input.events.push(event));
  const start = input.startFails
    ? Effect.fail(
        new DesktopAppActivation.DesktopAppActivationStartError({
          address: "/tmp/t3-app.sock",
          cause: new Error("EADDRINUSE"),
        }),
      )
    : Effect.acquireRelease(record("control:start"), () => record("control:close"));

  return Layer.mergeAll(
    Layer.succeed(DesktopAppActivation.DesktopAppActivation, {
      start,
      setRendererReady: () => Effect.void,
      complete: () => Effect.void,
    }),
    Layer.succeed(DesktopWindow.DesktopWindow, {
      createMainIfBackendReady: record("window:create"),
    } as unknown as DesktopWindow.DesktopWindow["Service"]),
    Layer.effect(
      DesktopState.DesktopState,
      Effect.all({
        backendReady: Ref.make(false),
        quitting: Ref.make(input.quitting ?? false),
      }),
    ),
  );
}

describe("DesktopApp remote-only bootstrap", () => {
  it.effect("serves `t3 app` without a local backend and closes it with the app scope", () => {
    const events: Array<string> = [];
    return Effect.gen(function* () {
      yield* Effect.scoped(bootstrapRemoteOnly);
      assert.deepEqual(events, ["window:create", "control:start", "control:close"]);
    }).pipe(Effect.provide(makeLayer({ events })));
  });

  it.effect("keeps starting when the control socket is unavailable", () => {
    const events: Array<string> = [];
    return Effect.gen(function* () {
      yield* Effect.scoped(bootstrapRemoteOnly);
      assert.deepEqual(events, ["window:create"]);
    }).pipe(Effect.provide(makeLayer({ events, startFails: true })));
  });

  it.effect("starts nothing while the app is quitting", () => {
    const events: Array<string> = [];
    return Effect.gen(function* () {
      yield* Effect.scoped(bootstrapRemoteOnly);
      assert.deepEqual(events, []);
    }).pipe(Effect.provide(makeLayer({ events, quitting: true })));
  });
});
