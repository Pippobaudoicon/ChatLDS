import { clerkClient } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  conversationMemories,
  conversations,
  messageFeedback,
  userMemoryPeriods,
  userMemoryProfiles,
  userSettings,
} from "@/lib/db/schema";
import { clearBillingEntitlementsCache } from "@/lib/billing/entitlements";

// Every table keyed by clerk_user_id. Deleting conversations also cascades to
// rag_messages (and any feedback still pointing at them).
// ponytail: db/clerk are parameters only so the test can pass fakes.
export async function deleteAccount(
  userId: string,
  db = getDb(),
  clerk: () => Promise<{ users: { deleteUser: (id: string) => Promise<unknown> } }> = clerkClient
) {
  await db.batch([
    db.delete(messageFeedback).where(eq(messageFeedback.clerkUserId, userId)),
    db.delete(userMemoryPeriods).where(eq(userMemoryPeriods.clerkUserId, userId)),
    db.delete(conversationMemories).where(eq(conversationMemories.clerkUserId, userId)),
    db.delete(userMemoryProfiles).where(eq(userMemoryProfiles.clerkUserId, userId)),
    db.delete(userSettings).where(eq(userSettings.clerkUserId, userId)),
    db.delete(conversations).where(eq(conversations.clerkUserId, userId)),
  ]);
  clearBillingEntitlementsCache(userId);

  try {
    await (await clerk()).users.deleteUser(userId);
  } catch (err) {
    // Already gone (retry) is success.
    if ((err as { status?: number }).status !== 404) throw err;
  }
}
