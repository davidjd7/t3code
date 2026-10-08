import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { DesktopAppActivationRequest } from "./desktopAppActivation.ts";

describe("desktop activation wire contract", () => {
  const isRequest = Schema.is(DesktopAppActivationRequest);
  const request = {
    version: 1,
    requestId: "r1",
    type: "open-thread",
    environmentId: "remote",
    threadId: "existing",
  };
  it("accepts exact thread navigation without a path or host platform", () => {
    expect(isRequest(request)).toBe(true);
  });
  it.each([
    { ...request, environmentId: undefined },
    { ...request, threadId: undefined },
    { ...request, environmentId: "" },
    { ...request, threadId: "" },
    { ...request, version: 2 },
    { ...request, type: "open-workspace" },
  ])("rejects an incomplete or incompatible request (%j)", (invalid) => {
    expect(isRequest(invalid)).toBe(false);
  });
});
