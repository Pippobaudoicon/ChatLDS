import { auth } from "@clerk/nextjs/server";
import { billingHandoffUrl } from "@/lib/auth/billing-handoff";

export const runtime = "nodejs";

// POST /api/billing/handoff — signed-in user (cookie or bearer) -> { url }.
// Origin comes from the request, so dev.chatlds.it yields a dev.chatlds.it URL.
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ url: await billingHandoffUrl(userId, req.url) });
}
