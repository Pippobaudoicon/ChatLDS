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

const CANCELLABLE = ["active", "upcoming", "past_due"];

// Cancel paid billing first (a deleted user can't sign in to cancel later, and
// a failure here leaves nothing half-deleted), then wipe every table keyed by
// clerk_user_id, then the Clerk user. Deleting conversations also cascades to
// rag_messages (and any feedback still pointing at them).
// ponytail: db/clerk are parameters only so the test can pass fakes; cancels
// immediately, no proration/refund handling.
export async function deleteAccount(
  userId: string,
  db = getDb(),
  clerk: typeof clerkClient = clerkClient
) {
  const client = await clerk();

  const sub = await client.billing.getUserBillingSubscription(userId).catch((err) => {
    const status = (err as { status?: number }).status;
    if (status === 404 || status === 403) return null; // user gone on retry / billing not enabled
    throw err;
  });
  for (const item of sub?.subscriptionItems ?? []) {
    if (item.plan && !item.plan.isDefault && CANCELLABLE.includes(item.status)) {
      await client.billing.cancelSubscriptionItem(item.id, { endNow: true });
    }
  }

  await db.batch([
    db.delete(messageFeedback).where(eq(messageFeedback.clerkUserId, userId)),
    db.delete(userMemoryPeriods).where(eq(userMemoryPeriods.clerkUserId, userId)),
    db.delete(conversationMemories).where(eq(conversationMemories.clerkUserId, userId)),
    db.delete(userMemoryProfiles).where(eq(userMemoryProfiles.clerkUserId, userId)),
    db.delete(userSettings).where(eq(userSettings.clerkUserId, userId)),
    db.delete(conversations).where(eq(conversations.clerkUserId, userId)),
  ]);

  try {
    await client.users.deleteUser(userId);
  } catch (err) {
    // Already gone (retry) is success.
    if ((err as { status?: number }).status !== 404) throw err;
  }
}
