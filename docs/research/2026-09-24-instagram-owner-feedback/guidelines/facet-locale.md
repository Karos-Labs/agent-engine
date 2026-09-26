# facet-locale (qualifier, not a layer: en, he, pt-BR, fr, es, multi)

id: facet-locale · version 1.1 · layer: L2 (facet card) · clients: en: karoslabs, thepitchbydeel, hankypanky, kindlyyours, sitti, dontechno, he: geektime, pt-BR (jurisdiction BR): xodigital, fr: n3

Standards and parameter values only; no line claims an engagement lift. Industry statistics appear as evidence refs (one vote per account, `scale.md`); a statistic from fewer than ~8 accounts is TRY-level evidence and never the basis of a DEFAULT on its own.

## Params

owns: script direction, register pack (readable-copy pattern sets), number/date/currency format, proofing pass, jurisdiction key fed to the L1 claims gate. Resolved exact locale, then base language, then default. Locale pools no evidence (perm_p 0.51-0.68).

## Lines

1. [MUST][language] en: base readable-copy pack ('X is not A. It is B.', 'Not X.' openers, fragment stacks, triads, meta lines, trailing ellipsis); jurisdiction from the client. (evidence: LANG-02; LANG-14)
2. [MUST][language] he (Geektime): RTL layout and bidi digits, mark anchored top-right or right of centre, letter-height floors instead of x-height, a face with native Hebrew glyphs in every role and the same family for Latin names, gender and number agreement, no Latin glued to Hebrew, at most one 'לא X.' per caption, no English corporate jargon, shekel placement and RTL bar order, 'תמונה: עיבוד AI' as the AI label; the pack needs a native reviewer before it may refuse a draft. (evidence: LANG-14/GFX-04/IMG-02/DS-10 locale notes; Geektime run shipped five 'לא X.')
3. [MUST][language] pt-BR (XO, jurisdiction BR): 'você' address, no English on slides, 'não X, mas Y' and 'O teto não era X. Era Y.' banned, decimal comma and 'R$ 6,5 mi', accented capitals at display line-height >= 1.1 and diacritics tested at ExtraBold, longer words with no hyphenation; jurisdiction BR selects the CVM claims list for the L1 claims gate. (evidence: LANG-14/LANG-02/A-2/C-3 locale notes; XO run 'O teto não era de capacidade. Era de regra.')
4. [MUST][language] fr (N3): complete French sentences with one fact each, technical words explained, no two-word flourishes, no anglicisms, no em dashes, non-breaking space before : ; ? !, accented capitals at line-height >= 1.1 and the degree sign checked in the kit faces, '1850' is a name never a measurement, no roman numerals; jurisdiction FR for the site's legal gate. (evidence: C-4/LANG-14/C-3 locale notes; albert-copy-must-mean-something)
5. [DEFAULT][language] es and multi: stubs that fall back to the base pack with a native proofread; opened as packs only when a client arrives. (evidence: taxonomy closed list)
