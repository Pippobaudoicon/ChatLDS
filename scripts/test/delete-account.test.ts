/**
 * Account deletion: every user-keyed table is wiped in one batch, then Clerk.
 * The route's 401 is not covered here (Clerk auth() needs a request context;
 * the repo has no route-handler test pattern), so this tests the extracted
 * deleteAccount() with fakes.
 *
 * Run: `pnpm run test:delete-account`
 */
import { deleteAccount } from "@/lib/auth/delete-account";
import {
  conversationMemories,
  conversations,
  messageFeedback,
  userMemoryPeriods,
  userMemoryProfiles,
  userSettings,
} from "@/lib/db/schema";

let failures = 0;
const check = (label: string, ok: boolean) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};

void (async () => {
  let batched: unknown[] = [];
  const db = {
    delete: (table: unknown) => ({ where: () => table }),
    batch: async (queries: unknown[]) => {
      batched = queries;
    },
  } as unknown as Parameters<typeof deleteAccount>[1];
  const deleted: string[] = [];
  const clerk = (status?: number) => async () => ({
    users: {
      deleteUser: async (id: string) => {
        deleted.push(id);
        if (status) throw Object.assign(new Error("clerk"), { status });
      },
    },
  });

  await deleteAccount("user_1", db, clerk());
  const expected = [
    messageFeedback,
    userMemoryPeriods,
    conversationMemories,
    userMemoryProfiles,
    userSettings,
    conversations,
  ];
  check(
    "deletes every user-keyed table in one batch",
    batched.length === expected.length && expected.every((t) => batched.includes(t))
  );
  check("then deletes the Clerk user", deleted[0] === "user_1");

  await deleteAccount("user_1", db, clerk(404));
  check("Clerk 404 (retry) is success", true);

  let threw = false;
  await deleteAccount("user_1", db, clerk(500)).catch(() => (threw = true));
  check("other Clerk errors propagate", threw);

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
})();
