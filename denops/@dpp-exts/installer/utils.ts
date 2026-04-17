export function getFormattedDate(date: Date): string {
  const year = date.getFullYear().toString().slice(-2);
  const month = ("0" + (date.getMonth() + 1)).slice(-2);
  const day = ("0" + date.getDate()).slice(-2);
  const hours = ("0" + date.getHours()).slice(-2);
  const minutes = ("0" + date.getMinutes()).slice(-2);
  const seconds = ("0" + date.getSeconds()).slice(-2);

  return year + month + day + hours + minutes + seconds;
}

export function timeAgo(d: Date, now = new Date()): string {
  const diffSec = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (diffSec < 0) return "just now";
  if (diffSec < 60) {
    const s = diffSec;
    return `${s} second${s === 1 ? "" : "s"} ago`;
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    const m = diffMin;
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) {
    const h = diffHour;
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) {
    const dd = diffDay;
    return `${dd} day${dd === 1 ? "" : "s"} ago`;
  }
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) {
    const mo = diffMonth;
    return `${mo} month${mo === 1 ? "" : "s"} ago`;
  }
  const diffYear = Math.floor(diffDay / 365);
  const y = diffYear;
  return `${y} year${y === 1 ? "" : "s"} ago`;
}

/** Splits a text stream into lines, stripping CR characters. */
function textLineStream(): TransformStream<string, string> {
  let buf = "";
  return new TransformStream<string, string>({
    transform(chunk, controller) {
      buf += chunk;
      const parts = buf.split("\n");
      for (let i = 0; i < parts.length - 1; i++) {
        controller.enqueue(parts[i].replace(/\r$/, ""));
      }
      buf = parts[parts.length - 1];
    },
    flush(controller) {
      if (buf.length > 0) {
        controller.enqueue(buf.replace(/\r$/, ""));
      }
    },
  });
}

// Robust pipeStream: reads Uint8Array stream as text lines and calls writer for each line.
// Propagates errors thrown by writer so callers can handle/log them.
export async function pipeStream(
  stream: ReadableStream<Uint8Array>,
  writer: (msg: string) => unknown | Promise<unknown>,
): Promise<void> {
  const decoded = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(textLineStream());

  const writable = new WritableStream<string>({
    write: async (chunk) => {
      // If the writer throws, allow the pipeTo() promise to reject.
      await writer(chunk);
    },
  });

  await decoded.pipeTo(writable);
}
