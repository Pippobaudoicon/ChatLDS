import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";
import {
  GUEST_COOKIE,
  claimGuestConversations,
  guestIdFromCookie,
} from "@/lib/auth/guest";
import {
  REMEMBER_COOKIE,
  SIGNED_OUT_PARAM,
  forgetUser,
  redeem,
  rememberUser,
  rememberedUserId,
} from "@/lib/auth/remember";

// Auth is checked where the data is (each page and route calls getViewer() or
// auth()), not here. The proxy only hands signed-out visitors of the
// guest-capable routes a guest id (quota-limited, see entitlements).
const GUEST_PATHS = [
  "/chat",
  "/api/chat",
  "/api/conversations",
  "/api/feedback",
  "/api/settings",
  "/api/billing/subscription",
];

function isGuestRoute(pathname: string) {
  return GUEST_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

const GUEST_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

// A full page load (not RSC/prefetch/fetch) outside the auth pages: the only
// requests we bounce through /sign-in to restore a remembered session.
function isResumablePageLoad(req: NextRequest) {
  const { pathname } = req.nextUrl;
  return (
    req.method === "GET" &&
    req.headers.get("sec-fetch-mode") === "navigate" &&
    !pathname.startsWith("/sign-in") &&
    !pathname.startsWith("/sign-up")
  );
}

export default clerkMiddleware(async (auth, req) => {
  const { userId } = await auth();
  const guestCookie = req.cookies.get(GUEST_COOKIE)?.value;
  const remember = req.cookies.get(REMEMBER_COOKIE)?.value;

  if (userId) {
    const remembered = rememberedUserId(remember) === userId;
    if (!guestCookie && remembered) return;
    const res = NextResponse.next();
    if (guestCookie) {
      // Just signed in/up from a guest session: carry the guest's chats over.
      const guestId = guestIdFromCookie(guestCookie);
      if (guestId) await claimGuestConversations(guestId, userId);
      res.cookies.delete(GUEST_COOKIE);
    }
    if (!remembered) {
      // ponytail: parallel first requests may each mint a cookie; the losers'
      // Redis keys just expire unused after a year.
      try {
        if (remember) await forgetUser(res, remember);
        await rememberUser(res, userId);
      } catch (err) {
        console.error("[remember] issue failed", err);
      }
    }
    return res;
  }

  if (remember && req.nextUrl.searchParams.has(SIGNED_OUT_PARAM)) {
    const res = NextResponse.next();
    await forgetUser(res, remember).catch((err) => console.error("[remember] forget failed", err));
    return res;
  }

  // Clerk session expired (free plan: 7 days) but this browser is remembered.
  if (remember && isResumablePageLoad(req)) {
    const redeemed = await redeem(remember).catch((err) => {
      console.error("[remember] redeem failed", err);
      return null;
    });
    if (redeemed) {
      const url = new URL("/sign-in", req.url);
      url.searchParams.set("__clerk_ticket", redeemed.ticket);
      url.searchParams.set("redirect_url", req.nextUrl.href);
      const res = NextResponse.redirect(url);
      await rememberUser(res, redeemed.userId).catch((err) =>
        console.error("[remember] rotate failed", err)
      );
      return res;
    }
  }

  if (!isGuestRoute(req.nextUrl.pathname)) return;
  if (guestIdFromCookie(guestCookie)) return;
  const res = NextResponse.next();
  res.cookies.set(GUEST_COOKIE, crypto.randomUUID(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: GUEST_COOKIE_MAX_AGE_SECONDS,
  });
  return res;
});

export const config = {
  matcher: [
    // Skip Next.js internals and static files
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
