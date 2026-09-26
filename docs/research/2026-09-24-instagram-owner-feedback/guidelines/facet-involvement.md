# facet-involvement (closed list of 3) + audience modifier (B2B / B2C / mixed; two keys only)

id: facet-involvement · version 1.1 · layer: L2 (facet card) · clients: karoslabs: high, B2B, geektime: none, mixed, thepitchbydeel: high, mixed, hankypanky: low (borderline, AOV rationale logged), B2C, kindlyyours: low, B2C, sitti: low, mixed, xodigital: high (regulated), B2C, dontechno: none, B2C, n3: high, B2C

Standards and parameter values only; no line claims an engagement lift. Industry statistics appear as evidence refs (one vote per account, `scale.md`); a statistic from fewer than ~8 accounts is TRY-level evidence and never the basis of a DEFAULT on its own.

## Params

owns: default_post_job_mix (entertain/inspire/educate/convince), brand_vs_activation_ratio (60:40 default), cta_intensity, register_intensity, format_lead. Audience modifier may shift exactly two keys: brand_vs_activation_ratio (toward 50:50 for B2B) and proof_person_style (named company or person for B2B). Three-question rule on the primary revenue line: (a) is the posting itself what the audience comes for, money following attention? none; (b) does acting need research, money or commitment (regulated, order > ~$100, B2B contract, an application costing days)? high; (c) otherwise low. A product line may override involvement per run.

## Lines

1. [DEFAULT][strategy] none (content is the product): post-job mix seed 4 entertain / 2 educate / 0 convince; brand_vs_activation 80:20; cta_intensity none (a credit line, no ask); register plain authoritative or editorial; format_lead follows the page's own grid (reels or 2-slide cards). (evidence: DT 'no CTA' 14% vs 12%; music authoritative 7+/0-; taxonomy judge seeds are authored, not measured)
2. [DEFAULT][strategy] low (act within minutes, under ~$100, unregulated): mix seed 3 entertain / 1 educate / 2 convince; brand_vs_activation 60:40; cta_intensity one answerable ask per post, rotated; register emotional or creator first-person; format_lead neutral, decided by the client's own grid. (evidence: intimates comment prompt 11+/1- p=0.006; creator emotional 5+/0-; format neutral within intimates)
3. [DEFAULT][strategy] high (research, money, commitment or regulated): mix seed 2 entertain / 3 educate / 1 convince; brand_vs_activation 60:40 (50:50 with the B2B modifier); cta_intensity low (save/share, a waitlist, or none; never comment bait); register conversational; format_lead carousel for text-and-picture accounts, judged on saves and sends. (evidence: startup and B2B link-in-bio 2+/7- and 0.6; a16z carousels 1.14x vs images 0.80x)
4. [DEFAULT][strategy] Audience modifier B2B: brand_vs_activation to 50:50 and proof_person_style = named company or named person; B2C and mixed leave both keys at the involvement default. (evidence: robustness-v2 audience skill +0.0066; Binet & Field emotion works in B2B too, per taxonomy judge)
5. [MUST][process] Involvement never carries an engagement delta until the facet passes the skill gate (leave-one-account-out skill >= +0.01 with perm_p < 0.05 on two consecutive runs, >= 20 accounts per group, surviving the drop of any one source client, and winning in the L3 data of >= 2 Karos clients); until then these rows are standards only. (evidence: robustness-v2 involvement +0.0096 p=0.01 but carousels-only negative; design:impact jackknife)
6. [DEFAULT][process] Mix seeds are re-checked quarterly against the override log: a default overturned in most clients is demoted. (evidence: taxonomy judge how_guidance_composes)
