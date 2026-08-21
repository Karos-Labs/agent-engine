import { example } from "@/content/example";
import { SiteNav } from "@/components/site-nav";
import { Hero } from "@/components/hero";
import { PartnerMarquee } from "@/components/partner-marquee";
import { ProofStrip } from "@/components/proof-strip";
import { FlagshipProof } from "@/components/flagship-proof";
import { HowItWorks } from "@/components/how-it-works";
import { SignatureShowcase } from "@/components/signature-showcase";
import { Offering } from "@/components/offering";
import { Faq } from "@/components/faq";
import { SiteFooter } from "@/components/site-footer";
import { CoachChatbot } from "@/components/coach-chatbot";

/* ============================================================
 * CONTENT-DRIVEN COMPOSITION (the kit's baseline page).
 *
 * Each section renders ONLY when intake supplied its content. A client with no
 * signatureShowcase still gets a clean page; a client with extra (bespoke)
 * sections gets a custom page.tsx variant. Nothing here is hardcoded to one
 * brand — every string flows from the content object.
 *
 * To build a client: point this import at the client's content file
 * (e.g. `import { acme } from "@/content/acme"`), set its tokens in globals.css
 * + fonts in layout.tsx, and add/omit/reorder section lines below. Bespoke
 * sections (media galleries, calculators, custom backdrops) are new components
 * the agent adds and wires in here, consuming content.media / content.customSections.
 * ============================================================ */

export default function Page() {
  const c = example;
  const coach = c.carryForward?.find((w) => w.type === "chatbot");

  return (
    <>
      <SiteNav nav={c.nav} />
      <main className="flex-1">
        <Hero hero={c.hero} />
        {c.partners && <PartnerMarquee label={c.partnersLabel} partners={c.partners} />}
        {c.proofStrip && <ProofStrip proof={c.proofStrip} />}
        {c.flagshipProof && <FlagshipProof data={c.flagshipProof} />}
        {c.howItWorks && <HowItWorks data={c.howItWorks} />}
        {c.signatureShowcase && <SignatureShowcase data={c.signatureShowcase} />}
        {c.offering && <Offering data={c.offering} />}
        {c.faq && <Faq data={c.faq} />}
        {/* Bespoke / custom sections the agent adds per client are rendered here,
            consuming c.media and c.customSections (see content-schema.ts). */}
      </main>
      <SiteFooter footer={c.footer} />
      {coach && <CoachChatbot label={coach.label} />}
    </>
  );
}
