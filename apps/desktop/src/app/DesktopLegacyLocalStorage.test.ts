import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as Legacy from "./DesktopLegacyLocalStorage.ts";

it.effect("never inspects or imports real V1 storage into an isolated preview", () => {
  let inspected = 0;
  const fs = FileSystem.makeNoop({
    exists: () =>
      Effect.sync(() => {
        inspected++;
        return false;
      }),
    readDirectory: () =>
      Effect.sync(() => {
        inspected++;
        return [];
      }),
  });
  const environment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: "/preview",
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: "/preview/profile",
          T3CODE_DESKTOP_USER_DATA_DIR: "/preview/electron",
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const legacy = yield* Legacy.DesktopLegacyLocalStorage;
    yield* legacy.load("/preview/electron");
    assert.isTrue(Option.isNone(yield* legacy.take));
    assert.equal(inspected, 0);
  }).pipe(
    Effect.provide(Legacy.layer),
    Effect.provide(environment),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provide(NodeServices.layer),
  );
});
