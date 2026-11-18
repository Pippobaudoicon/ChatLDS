/**
 * Account deletion: paid billing is cancelled, then every user-keyed table is
 * wiped in one batch, then Clerk. The route's 401 is not covered here (Clerk
 * auth() needs a request context; the repo has no route-handler test pattern),
 * so this tests the extracted deleteAccount() with a real (unconnected)
 * drizzle instance for SQL generation and a stubbed Clerk client.
 *
 * Run: `pnpm run test:delete-account`
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { deleteAccount } from "@/lib/auth/delete-account";
import * as schema from "@/lib/db/schema";

let failures = 0;
const check = (label: string, ok: boolean) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};

const tables = [
  "rag_message_feedback",
  "rag_user_memory_periods",
  "rag_conversation_memories",
  "rag_user_memory_profiles",
  "rag_user_settings",
  "rag_conversations",
];

type Item = { id: string; status: string; plan: { isDefault: boolean } | null };

async function run(opts: { items?: Item[]; billingError?: number; deleteError?: number }) {
  const calls: string[] = [];
  let statements: { sql: string; params: unknown[] }[] = [];
  const real = drizzle({ client: neon("postgresql://u:p@localhost/db"), schema });
  const db = {
    delete: real.delete.bind(real),
    batch: async (qs: { toSQL: () => { sql: string; params: unknown[] } }[]) => {
      calls.push("batch");
      statements = qs.map((q) => q.toSQL());
    },
  } as unknown as Parameters<typeof deleteAccount>[1];
  const clerk = (async () => ({
    billing: {
      getUserBillingSubscription: async () => {
        if (opts.billingError) throw Object.assign(new Error("billing"), { status: opts.billingError });
        return { subscriptionItems: opts.items ?? [] };
      },
      cancelSubscriptionItem: async (id: string, p: { endNow: boolean }) => {
        calls.push(`cancel:${id}:${p.endNow}`);
      },
    },
    users: {
      deleteUser: async (id: string) => {
        calls.push(`delete:${id}`);
        if (opts.deleteError) throw Object.assign(new Error("clerk"), { status: opts.deleteError });
      },
    },
  })) as unknown as Parameters<typeof deleteAccount>[2];
  const error = await deleteAccount("user_1", db, clerk).then(
    () => null,
    (e: unknown) => e
  );
  return { calls, statements, error };
}

void (async () => {
  const items: Item[] = [
    { id: "free", status: "active", plan: { isDefault: true } },
    { id: "pro", status: "active", plan: { isDefault: false } },
    { id: "next", status: "upcoming", plan: { isDefault: false } },
    { id: "old", status: "ended", plan: { isDefault: false } },
    { id: "noplan", status: "active", plan: null },
  ];
  const r = await run({ items });
  check(
    "every statement deletes only the user's rows",
    r.statements.length === tables.length &&
      tables.every(
        (t, i) =>
          r.statements[i].sql ===
            `delete from "${t}" where "${t}"."clerk_user_id" = $1` &&
          r.statements[i].params[0] === "user_1" &&
          r.statements[i].params.length === 1
      )
  );
  check(
    "cancels only active/upcoming non-default items, then batch, then Clerk delete",
    r.calls.join(",") === "cancel:pro:true,cancel:next:true,batch,delete:user_1"
  );

  for (const status of [404, 403]) {
    const t = await run({ billingError: status });
    check(`billing ${status} is tolerated`, t.error === null && t.calls.join(",") === "batch,delete:user_1");
  }
  const b = await run({ billingError: 500 });
  check("other billing errors abort before any delete", b.error !== null && b.calls.length === 0);

  const gone = await run({ deleteError: 404 });
  check("Clerk 404 (retry) is success after the batch", gone.error === null && gone.calls.join(",") === "batch,delete:user_1");
  const fail = await run({ deleteError: 500 });
  check("other Clerk errors propagate", fail.error !== null);

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
})();
