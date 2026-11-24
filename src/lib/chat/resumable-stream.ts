import { after } from "next/server";
import {
  createResumableStreamContext,
  type Publisher,
  type ResumableStreamContext,
  type Subscriber,
} from "resumable-stream/generic";
import type { Redis } from "@upstash/redis";
import { getRedis, hasRedisConfig } from "@/lib/rag/cache";

let streamContext: ResumableStreamContext | null = null;

function stringifyMessage(message: unknown): string {
  return typeof message === "string" ? message : JSON.stringify(message);
}

export function createUpstashPublisher(redis: Redis = getRedis()): Publisher {
  return {
    connect: async () => undefined,
    // Upstash REST subscribe is SSE split on "\n", so a raw multi-line payload
    // (every SSE chunk, the replay, the DONE marker) arrives truncated and the
    // resumer hangs. JSON-encode it; the subscriber's auto-deserialize undoes it.
    publish: (channel, message) =>
      redis.publish(channel, JSON.stringify(message)),
    set: (key, value, options) =>
      redis.set(key, value, options?.EX ? { ex: options.EX } : undefined),
    get: (key) => redis.get<string | number>(key),
    incr: (key) => redis.incr(key),
  };
}

function createUpstashSubscriber(): Subscriber {
  const redis = getRedis();
  const subscriptions = new Map<
    string,
    ReturnType<typeof redis.subscribe<unknown>>
  >();

  return {
    connect: async () => undefined,
    subscribe: async (channel, callback) => {
      const existing = subscriptions.get(channel);
      if (existing) await existing.unsubscribe([channel]);

      const subscription = redis.subscribe<unknown>(channel);
      subscriptions.set(channel, subscription);

      await new Promise<void>((resolve, reject) => {
        let subscribed = false;
        subscription.on("message", ({ message }) => {
          void callback(stringifyMessage(message));
        });
        subscription.on("subscribe", () => {
          subscribed = true;
          resolve();
        });
        subscription.on("error", (error) => {
          if (!subscribed) reject(error);
          else console.error("Resumable stream subscription failed", error);
        });
      });
    },
    unsubscribe: async (channel) => {
      const subscription = subscriptions.get(channel);
      if (!subscription) return;
      subscriptions.delete(channel);
      await subscription.unsubscribe([channel]);
    },
  };
}

export function isChatStreamResumeConfigured(): boolean {
  return hasRedisConfig();
}

export function getChatStreamContext(): ResumableStreamContext | null {
  if (!isChatStreamResumeConfigured()) return null;
  if (!streamContext) {
    streamContext = createResumableStreamContext({
      keyPrefix: "rag:v2:chat-stream",
      publisher: createUpstashPublisher(),
      subscriber: createUpstashSubscriber(),
      waitUntil: (promise) => after(promise),
    });
  }
  return streamContext;
}
