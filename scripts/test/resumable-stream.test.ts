/**
 * Resumable-stream payloads must survive Upstash REST pub/sub, whose subscribe
 * is SSE split on "\n" (only the first `data: ` line of a message is kept).
 * Simulates that wire on what the app's publisher sends.
 *
 * Run: `pnpm run test:resumable-stream`
 */
import type { Redis } from "@upstash/redis";
import { createUpstashPublisher } from "@/lib/chat/resumable-stream";

let failures = 0;
const check = (label: string, ok: boolean) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};

// What @upstash/redis's Subscriber hands the "message" listener for a publish.
function upstashWire(channel: string, payload: string): unknown {
  const firstLine = `data: message,${channel},${payload}`.split("\n")[0];
  const raw = firstLine.slice(`data: message,${channel},`.length);
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function main() {
  const published: string[] = [];
  const redis = {
    publish: async (_: string, message: string) => {
      published.push(message);
      return 1;
    },
  } as unknown as Redis;
  const publisher = createUpstashPublisher(redis);

  const messages = [
    'data: {"type":"text-delta","id":"0","delta":"a"}\n\ndata: {"type":"text-delta","id":"0","delta":"b"}\n\n',
    "\n\n\nDONE_SENTINEL_hasdfasudfyge374%$%^$EDSATRTYFtydryrte\n",
    JSON.stringify({ listenerId: "l1", skipCharacters: 0 }),
    "",
  ];
  for (const message of messages) await publisher.publish("ch", message);

  messages.forEach((message, i) => {
    check(
      `round-trips ${JSON.stringify(message.slice(0, 24))}…`,
      upstashWire("ch", published[i]) === message
    );
  });

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
}

void main();
