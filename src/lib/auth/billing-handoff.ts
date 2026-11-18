import { clerkClient } from "@clerk/nextjs/server";

// Native apps can't take payments in-app, so they open this URL in the system
// browser: /sign-in redeems the single-use ticket (same flow as the
// remember-me redirect in proxy.ts) and lands on /billing.
export async function billingHandoffUrl(userId: string, origin: string, clerk = clerkClient) {
  const { token } = await (await clerk()).signInTokens.createSignInToken({
    userId,
    expiresInSeconds: 60,
  });
  const url = new URL("/sign-in", origin);
  url.searchParams.set("__clerk_ticket", token);
  url.searchParams.set("redirect_url", "/billing");
  url.searchParams.set("uid", userId);
  return url.toString();
}

// Browser already signed in (SFSafariViewController / Custom Tabs often are):
// Clerk won't redeem the ticket, so for the SAME user skip /sign-in and go
// straight to redirect_url. A different user gets null: Clerk keeps them on
// their own account, so nothing is bought on the wrong one.
export function handoffRedirect(url: URL, userId: string): string | null {
  if (!url.searchParams.has("__clerk_ticket") || url.searchParams.get("uid") !== userId) return null;
  const to = url.searchParams.get("redirect_url") ?? "";
  return to.startsWith("/") && !to.startsWith("//") ? to : "/";
}
