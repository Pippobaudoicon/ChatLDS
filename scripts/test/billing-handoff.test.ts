/**
 * Billing handoff URL: /sign-in on the request's origin, carrying a 60s Clerk
 * sign-in ticket and redirect_url=/billing. The route's 401 is not covered
 * (Clerk auth() needs a request context; same limitation as delete-account).
 *
 * Run: `pnpm run test:billing-handoff`
 */
import { billingHandoffUrl, handoffRedirect } from "@/lib/auth/billing-handoff";

let failures = 0;
const check = (label: string, ok: boolean) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};

async function main() {
  const created: unknown[] = [];
  const clerk = (async () => ({
    signInTokens: {
      createSignInToken: async (p: unknown) => {
        created.push(p);
        return { token: "tkt_1" };
      },
    },
  })) as unknown as Parameters<typeof billingHandoffUrl>[2];

  const u = new URL(
    await billingHandoffUrl("user_1", "https://dev.chatlds.it/api/billing/handoff", clerk)
  );
  check("origin follows the request", u.origin === "https://dev.chatlds.it" && u.pathname === "/sign-in");
  check("ticket + redirect_url", u.searchParams.get("__clerk_ticket") === "tkt_1" && u.searchParams.get("redirect_url") === "/billing");
  check("uid carried", u.searchParams.get("uid") === "user_1");
  check("token for the user, 60s", JSON.stringify(created) === JSON.stringify([{ userId: "user_1", expiresInSeconds: 60 }]));
  const at = (q: string) => new URL(`https://x.it/sign-in?${q}`);
  check("same user -> redirect_url", handoffRedirect(at("__clerk_ticket=t&uid=u1&redirect_url=/billing"), "u1") === "/billing");
  check("different user -> null", handoffRedirect(at("__clerk_ticket=t&uid=u2&redirect_url=/billing"), "u1") === null);
  check("no ticket -> null", handoffRedirect(at("uid=u1&redirect_url=/billing"), "u1") === null);
  check("//evil -> /", handoffRedirect(at("__clerk_ticket=t&uid=u1&redirect_url=//evil.com"), "u1") === "/");
  check("absolute url -> /", handoffRedirect(at("__clerk_ticket=t&uid=u1&redirect_url=https://evil.com"), "u1") === "/");
  process.exit(failures ? 1 : 0);
}
main();
