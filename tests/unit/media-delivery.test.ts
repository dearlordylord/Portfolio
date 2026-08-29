import { describe, expect, it } from "vitest";

import {
  formatMediaDelivery,
  mediaDeliveryFromBlob,
  mediaDeliveryFromResponse,
  pendingMediaDelivery,
} from "../../src/motion/media-delivery";

describe("media delivery seekability", () => {
  it("keeps the pending state explicit", () => {
    expect(pendingMediaDelivery()).toEqual({
      mode: "pending",
      seekable: false,
      bytes: null,
      status: null,
      reason: "waiting for media response",
    });
  });

  it("treats a complete Blob as an intentionally seekable delivery", () => {
    const delivery = mediaDeliveryFromBlob(2048);
    expect(delivery).toMatchObject({ mode: "blob", seekable: true, bytes: 2048, status: 200 });
    expect(formatMediaDelivery(delivery)).toContain("blob · seekable");
  });

  it("requires both 206 and range headers before claiming HTTP seekability", () => {
    expect(mediaDeliveryFromResponse({
      status: 206,
      acceptRanges: "bytes",
      contentRange: "bytes 0-99/1000",
      bytes: 100,
    })).toMatchObject({ mode: "range", seekable: true });
    expect(mediaDeliveryFromResponse({ status: 200, acceptRanges: "bytes", bytes: 1000 })).toMatchObject({
      mode: "url",
      seekable: false,
      reason: "HTTP 200 without a verified byte-range response",
    });
    expect(mediaDeliveryFromResponse({ status: 206, contentRange: "bytes 0-99/1000" })).toMatchObject({
      mode: "url",
      seekable: false,
    });
  });

  it("does not describe an error response as playable", () => {
    expect(mediaDeliveryFromResponse({ status: 404 })).toMatchObject({
      mode: "failed",
      seekable: false,
      reason: "media response 404",
    });
  });
});
