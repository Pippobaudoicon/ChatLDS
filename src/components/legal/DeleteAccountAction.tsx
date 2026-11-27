"use client";

import { useClerk } from "@clerk/nextjs";
import Link from "next/link";
import { useState } from "react";
import type { TextLanguage, UI_TEXT } from "@/components/chat/i18n";

type Copy = (typeof UI_TEXT)[TextLanguage]["deleteAccount"];

// signed_out=1 makes the proxy burn the remember-me cookie (see proxy.ts).
const AFTER_DELETE_URL = "/delete-account?deleted=1&signed_out=1";

const BOX = "space-y-4 rounded-lg border p-5";
const BUTTON =
  "inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold transition disabled:opacity-60";

export function DeleteAccountAction({
  t,
  signedIn,
  deleted,
}: {
  t: Copy;
  signedIn: boolean;
  deleted: boolean;
}) {
  const { signOut } = useClerk();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  if (deleted && !signedIn) {
    return (
      <div className={`${BOX} border-emerald-400/30 bg-emerald-400/10`} role="status">
        <p className="text-lg font-semibold text-white">{t.doneTitle}</p>
        <p className="leading-7 text-zinc-300">{t.doneBody}</p>
      </div>
    );
  }

  if (!signedIn) {
    return (
      <div className={`${BOX} border-white/10 bg-white/4`}>
        <p className="leading-7 text-zinc-300">{t.signInPrompt}</p>
        <Link
          href="/sign-in?redirect_url=%2Fdelete-account"
          className={`${BUTTON} bg-white text-zinc-950 hover:bg-zinc-200`}
        >
          {t.signIn}
        </Link>
      </div>
    );
  }

  async function deleteAccount() {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch("/api/account", { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.error("[delete-account] failed", err);
      setFailed(true);
      setBusy(false);
      return;
    }
    // The Clerk user is already gone, so signOut may fail: land on the
    // confirmation either way.
    try {
      await signOut({ redirectUrl: AFTER_DELETE_URL });
    } catch {
      window.location.assign(AFTER_DELETE_URL);
    }
  }

  return (
    <div className={`${BOX} border-red-400/30 bg-red-500/5`}>
      <p className="leading-7 text-zinc-300">
        {confirming ? t.confirmPrompt : t.signedInPrompt}
      </p>
      {confirming ? (
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={deleteAccount}
            disabled={busy}
            className={`${BUTTON} bg-red-600 text-white hover:bg-red-500`}
          >
            {busy ? t.deleting : t.confirm}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={busy}
            className={`${BUTTON} border border-white/15 text-zinc-200 hover:bg-white/10`}
          >
            {t.cancel}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className={`${BUTTON} bg-red-600 text-white hover:bg-red-500`}
        >
          {t.delete}
        </button>
      )}
      {failed && (
        <p className="text-sm text-red-300" role="alert">
          {t.failed}
        </p>
      )}
    </div>
  );
}
