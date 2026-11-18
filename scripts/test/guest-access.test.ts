/**
 * Guest (signed-out) access: the cookie → guest id boundary and the guest quota.
 *
 * Run: `pnpm run test:guest`
 */
import { guestIdFromCookie, isGuestId } from "@/lib/auth/guest";
import { redeem, rememberedUserId } from "@/lib/auth/remember";
import { getBillingEntitlements } from "@/lib/billing/entitlements";

let failures = 0;
const check = (label: string, ok: boolean) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};

const uuid = "3f2b8c1e-9a4d-4e7b-8c2f-1a2b3c4d5e6f";
check("valid uuid cookie → guest id", guestIdFromCookie(uuid) === `guest:${uuid}`);
check("missing cookie → null", guestIdFromCookie(undefined) === null);
check("non-uuid cookie → null", guestIdFromCookie("user_2abc") === null);
check("injected cookie → null", guestIdFromCookie(`${uuid}' OR 1=1`) === null);
check("guest id detected", isGuestId(`guest:${uuid}`));
check("clerk id is not a guest", !isGuestId("user_2abcDEF"));

// Remember-me cookie `<userId>:<secret>` (src/lib/auth/remember.ts).
check("remember cookie → user id", rememberedUserId(`user_2abc:${uuid}`) === "user_2abc");
check("missing remember cookie → null", rememberedUserId(undefined) === null);
check("remember cookie without secret → null", rememberedUserId(uuid) === null);
check("remember cookie without user → null", rememberedUserId(`:${uuid}`) === null);

void (async () => {
  check("malformed remember cookie is not redeemed", (await redeem("garbage")) === null);

  const entitlements = await getBillingEntitlements(`guest:${uuid}`);
  check("guest plan", entitlements.plan === "guest" && !entitlements.isPro);
  check("guest quota is small", entitlements.limits.chatRequests === 5);
  check("guest window is 30d", entitlements.limits.window === "30d");

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
})();
