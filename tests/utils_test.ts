import { strict as assert } from "node:assert";
import {
  getFormattedDate,
  pipeStream,
  timeAgo,
} from "../denops/@dpp-exts/installer/utils.ts";

Deno.test("getFormattedDate returns YYMMDDhhmmss format", () => {
  // Use a fixed date and compute expected output based on local time to avoid
  // timezone-sensitive failures.
  const d = new Date(2023, 3, 5, 12, 34, 56); // month is 0-indexed: April = 3
  const s = getFormattedDate(d);
  // Expect exactly 12 characters (YYMMDDhhmmss)
  assert.equal(s.length, 12);
  // Year "23", month "04", day "05"
  assert.equal(s.slice(0, 6), "230405");
  // Hours "12", minutes "34", seconds "56"
  assert.equal(s.slice(6), "123456");
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
