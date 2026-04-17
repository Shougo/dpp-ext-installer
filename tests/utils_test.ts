import { strict as assert } from "node:assert";
import {
  getFormattedDate,
  pipeStream,
  timeAgo,
} from "../denops/@dpp-exts/installer/utils.ts";

Deno.test("getFormattedDate returns YYMMDDhhmmss format", () => {
  const d = new Date("2023-04-05T12:34:56Z");
  const s = getFormattedDate(d);
  // Expect 12 characters (YYMMDDhhmmss)
  assert.equal(s.length, 12);
  // Basic sanity: month/day/hh present
  assert.ok(s.includes("04"));
});

Deno.test("timeAgo outputs expected granularity", () => {
  const now = new Date();
  const oneSecAgo = new Date(now.getTime() - 1000);
  assert.ok(timeAgo(oneSecAgo, now).includes("second"));

  const oneMinAgo = new Date(now.getTime() - 60_000);
  assert.ok(timeAgo(oneMinAgo, now).includes("minute"));

  const oneHourAgo = new Date(now.getTime() - 60 * 60_000);
  assert.ok(timeAgo(oneHourAgo, now).includes("hour"));
});

Deno.test("pipeStream pipes lines to writer", async () => {
  const encoder = new TextEncoder();
  const lines = ["line1", "line2", "line3"];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) {
        controller.enqueue(encoder.encode(l + "\n"));
      }
      controller.close();
    },
  });

  const collected: string[] = [];
  await pipeStream(stream, (msg) => {
    collected.push(msg);
  });
  assert.equal(collected.length, lines.length);
  assert.equal(collected[0], "line1");
});
