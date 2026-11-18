import { auth } from "@clerk/nextjs/server";
import { deleteAccount } from "@/lib/auth/delete-account";

export const runtime = "nodejs";

// DELETE /api/account — erase the signed-in user's data, then their Clerk
// account (App Store / Play account-deletion requirement). Real users only:
// guests have no account, so no getViewer().
export async function DELETE() {
  const { userId } = await auth();
  if (!userId) return new Response("Unauthorized", { status: 401 });

  try {
    await deleteAccount(userId);
  } catch (err) {
    console.error("[account] delete failed", err);
    return Response.json({ error: "Account deletion failed" }, { status: 502 });
  }
  return new Response(null, { status: 204 });
}
