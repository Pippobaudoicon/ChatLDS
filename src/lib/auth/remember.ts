import { clerkClient } from "@clerk/nextjs/server";
import type { NextResponse } from "next/server";
import { getRedis } from "@/lib/rag/cache";

// "Stay signed in" on top of Clerk's free plan, whose sessions die after a
// fixed 7 days. Signed-in browsers get a 1-year httpOnly cookie
// `<userId>:<secret>`; Redis maps sha256(secret) -> userId. When the Clerk
// session is gone, the proxy trades the cookie (single use, rotated) for a
// Clerk sign-in token and sends the browser to /sign-in?__clerk_ticket=…,
// which <SignIn /> redeems on its own.
export const REMEMBER_COOKIE = "chatlds_remember";
// afterSignOutUrl carries this so a real sign-out forgets the device.
export const SIGNED_OUT_PARAM = "signed_out";
const MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

async function redisKey(secret: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return `remember:${Buffer.from(digest).toString("hex")}`;
}

function parse(value: string | undefined) {
  const i = value?.lastIndexOf(":") ?? -1;
  return value && i > 0 ? { userId: value.slice(0, i), secret: value.slice(i + 1) } : null;
}

export function rememberedUserId(value: string | undefined): string | null {
  return parse(value)?.userId ?? null;
}

export async function rememberUser(res: NextResponse, userId: string) {
  const secret = crypto.randomUUID();
  await getRedis().set(await redisKey(secret), userId, { ex: MAX_AGE_SECONDS });
  res.cookies.set(REMEMBER_COOKIE, `${userId}:${secret}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function forgetUser(res: NextResponse, value: string) {
  res.cookies.delete(REMEMBER_COOKIE);
  const parsed = parse(value);
  if (parsed) await getRedis().del(await redisKey(parsed.secret));
}

// Burns the cookie's secret and returns a fresh Clerk sign-in ticket for its
// user, or null when the secret is unknown/expired/forged.
export async function redeem(value: string): Promise<{ userId: string; ticket: string } | null> {
  const parsed = parse(value);
  if (!parsed) return null;
  const owner = await getRedis().getdel<string>(await redisKey(parsed.secret));
  if (owner !== parsed.userId) return null;
  const client = await clerkClient();
  const { token } = await client.signInTokens.createSignInToken({
    userId: owner,
    expiresInSeconds: 120,
  });
  return { userId: owner, ticket: token };
}
