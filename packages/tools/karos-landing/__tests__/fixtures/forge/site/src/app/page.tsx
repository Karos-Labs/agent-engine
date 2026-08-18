import { forge } from "@/content/forge";
import { SiteNav } from "@/components/site-nav";
import { Hero } from "@/components/hero";
import { ProofStrip } from "@/components/proof-strip";
import { FlagshipProof } from "@/components/flagship-proof";
import { HowItWorks } from "@/components/how-it-works";
import { SignatureShowcase } from "@/components/signature-showcase";
import { Offering } from "@/components/offering";
import { Faq } from "@/components/faq";
import { SiteFooter } from "@/components/site-footer";
import { CoachChatbot } from "@/components/coach-chatbot";

/* Content-driven composition: a section renders ONLY when intake supplied its content.
   FORGE has no `team`, so no team section exists — no fintech-shaped template is forced. */

export default function Page() {
  const c = forge;
  const coach = c.carryForward?.find((w) => w.type === "chatbot");

  return (
    <>
      <SiteNav nav={c.nav} />
      <main className="flex-1">
        <Hero hero={c.hero} />
        {c.proofStrip && <ProofStrip proof={c.proofStrip} />}
        {c.flagshipProof && <FlagshipProof data={c.flagshipProof} />}
        {c.howItWorks && <HowItWorks data={c.howItWorks} />}
        {c.signatureShowcase && <SignatureShowcase data={c.signatureShowcase} />}
        {c.offering && <Offering data={c.offering} />}
        {c.faq && <Faq data={c.faq} />}
      </main>
      <SiteFooter footer={c.footer} />
      {coach && <CoachChatbot label={coach.label} />}
    </>
  );
}
