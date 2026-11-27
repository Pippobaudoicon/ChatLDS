import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { deviceLanguage } from "@/components/auth/AuthShell";
import { UI_TEXT } from "@/components/chat/i18n";
import { DeleteAccountAction } from "@/components/legal/DeleteAccountAction";
import { LegalMailLink, LegalPageLayout } from "@/components/legal/LegalPageLayout";

// Public account-deletion page (Google Play "delete account URL"). Signed-out
// visitors get the explanation plus a sign-in link back here; signed-in users
// can delete via the existing DELETE /api/account.
export async function generateMetadata(): Promise<Metadata> {
  const t = UI_TEXT[await deviceLanguage()].deleteAccount;
  return {
    title: t.metaTitle,
    description: t.metaDescription,
    openGraph: {
      type: "website",
      title: t.metaTitle,
      description: t.metaDescription,
      siteName: "ChatLDS",
      url: "/delete-account",
    },
  };
}

const H2 = "text-2xl font-semibold tracking-tight text-white";
const P = "leading-7 text-zinc-300";

export default async function DeleteAccountPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const t = UI_TEXT[await deviceLanguage()].deleteAccount;
  const { userId } = await auth();
  const deleted = (await searchParams).deleted === "1";

  return (
    <LegalPageLayout
      accent="emerald"
      activePage="delete-account"
      eyebrow={t.eyebrow}
      title={t.title}
      description={t.description}
    >
      <article className="rounded-lg border border-white/10 bg-zinc-900/70 p-6 shadow-xl shadow-black/30 sm:p-8 lg:p-10">
        <div className="max-w-none space-y-9">
          <DeleteAccountAction t={t} signedIn={Boolean(userId)} deleted={deleted} />

          <section className="space-y-4" aria-labelledby="which-app">
            <h2 id="which-app" className={H2}>
              {t.appTitle}
            </h2>
            <p className={P}>{t.appBody}</p>
          </section>

          <section className="space-y-4" aria-labelledby="how-to-delete">
            <h2 id="how-to-delete" className={H2}>
              {t.howTitle}
            </h2>
            <ol className="list-decimal space-y-2 pl-5 leading-7 text-zinc-300">
              {t.howSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className={P}>{t.howApp}</p>
            <p className={P}>
              {t.howEmailBefore}
              <LegalMailLink accent="emerald" />
              {t.howEmailAfter}
            </p>
          </section>

          <section className="space-y-4" aria-labelledby="what-is-deleted">
            <h2 id="what-is-deleted" className={H2}>
              {t.deletedTitle}
            </h2>
            <ul className="list-disc space-y-2 pl-5 leading-7 text-zinc-300">
              {t.deletedItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>

          <section className="space-y-4" aria-labelledby="what-may-be-kept">
            <h2 id="what-may-be-kept" className={H2}>
              {t.keptTitle}
            </h2>
            <ul className="list-disc space-y-2 pl-5 leading-7 text-zinc-300">
              {t.keptItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        </div>
      </article>
    </LegalPageLayout>
  );
}
