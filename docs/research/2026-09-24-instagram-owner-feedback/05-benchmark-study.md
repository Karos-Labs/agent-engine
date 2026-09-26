# Benchmark study: 87 accounts, 7 clients, within-account outliers

Method: ScrappyCoco scraped about 30 recent posts per account. Engagement is likes + 3 × comments. Each post is ranked against its own account's median, which controls for audience size. For the 6 best and 6 weakest non-pinned posts of each account, an agent tagged format, layout, text sizes, words, fonts, graphics, imagery, hook, language and CTA from the images and captions. Statistics count one vote per account: the share of an account's best posts carrying a tag minus the share of its weakest. Total scraping cost across the round: about $0.85.

## Accounts per client

- **karoslabs** (14): @reputeforge (1592088 followers), @orenmeetsworld (745586 followers), @neilpatel (678373 followers), @becauseofmarketing (331814 followers), @sintra.ai (177026 followers), @peoplebrandsandthings (164320 followers), @thebrandblueprint_ (158355 followers), @ericosiu (116682 followers), @nogood.io (50874 followers), @viralnation (40622 followers), @npdigitalglobal (26324 followers), @askokara (9941 followers), @smartsitesnj (2689 followers), @karoslabs (22 followers)
- **kindlyyours** (12): @aerie (1807841 followers), @pact (980541 followers), @knix (639447 followers), @honeylove (633426 followers), @shapermint (589601 followers), @meundies (454643 followers), @wearpepper (325268 followers), @tomboyx (246457 followers), @felinaintimates (126751 followers), @harperwilde (122368 followers), @oeak_official (60117 followers), @teamkindly (19492 followers)
- **xodigital** (13): @thiago.nigro (10890250 followers), @infomoney (2857852 followers), @mepoupenaweb (2114698 followers), @gustavocerbasi (1803442 followers), @nathfinancas (973518 followers), @mariliadfontes (285271 followers), @gcbinvestimentos (160328 followers), @hurst.capital (87341 followers), @invistainco (46195 followers), @tokeniza.com.br (16554 followers), @liqibr (14689 followers), @eqseedinvestimentos (10067 followers), @xodigital.oficial (385 followers)
- **hankypanky** (12): @skims (7316438 followers), @savagexfenty (5094356 followers), @aerie (1807841 followers), @thirdlove (441847 followers), @lovestoriesintimates (375824 followers), @negative (326232 followers), @btemptdbras (299669 followers), @somaintimates (256131 followers), @felinaintimates (126751 followers), @wearcommando (124299 followers), @hankypanky (93538 followers), @natori (78225 followers)
- **geektime** (12): @evolving.ai (4822243 followers), @wired (2363675 followers), @morningbrew (2261526 followers), @push.il (970105 followers), @ynetgram (463258 followers), @visualcap (413070 followers), @israel.business (167936 followers), @calcalist (83903 followers), @globesnews (55822 followers), @themarker_online (37414 followers), @geektimecoil (11438 followers), @people_computers (3833 followers)
- **sitti** (13): @secret_nyc (2414659 followers), @beli_eats (908489 followers), @infatuation (801387 followers), @prettycitylondon (391613 followers), @stanforcreators (253229 followers), @wherethefuckdowego (109170 followers), @yallabikes (108281 followers), @mindtrip.ai (59477 followers), @mapstr (38214 followers), @spottedbylocals (9473 followers), @rexbycom (7111 followers), @sitti.app (615 followers), @letsdiscoverapp (519 followers)
- **thepitchbydeel** (13): @steven (5268094 followers), @sahilbloom (1024014 followers), @ycombinator (741656 followers), @a16z (209990 followers), @founderspodcast (207322 followers), @500global (123165 followers), @techstars (99987 followers), @hultprize (64616 followers), @antlerglobal (26077 followers), @deelpitch (23461 followers), @join_ef (17021 followers), @speedrun (8781 followers), @startupworldcup (7299 followers)

## Within-account statistics

### ALL ACCOUNTS (accounts=87)
- color_mood=photo-dominant: mean within-account diff +0.15 over 63 accts (39+/15-, sign p=0.0015)
- color_mood=muted/neutral: mean within-account diff -0.11 over 70 accts (17+/36-, sign p=0.0127)
- cta=link in bio/shop: mean within-account diff -0.13 over 51 accts (13+/31-, sign p=0.0096)
- cta=comment prompt: mean within-account diff +0.13 over 46 accts (29+/14-, sign p=0.0315)
- hook_type=none: mean within-account diff -0.21 over 15 accts (1+/13-, sign p=0.0018)
- graphic_devices=boxes/cards: mean within-account diff -0.10 over 54 accts (13+/28-, sign p=0.0275)
- language_register=emotional/personal: mean within-account diff +0.10 over 43 accts (25+/12-, sign p=0.047)
- logo_position=top-left: mean within-account diff -0.11 over 40 accts (12+/24-, sign p=0.0652)
- language_register=neutral/informational: mean within-account diff -0.10 over 51 accts (11+/27-, sign p=0.0139)
- hook_type=story/narrative: mean within-account diff +0.09 over 53 accts (30+/13-, sign p=0.0137)
- distinct_text_sizes=4+: mean within-account diff -0.10 over 39 accts (10+/25-, sign p=0.0167)
- sentence_form=mixed: mean within-account diff +0.08 over 64 accts (38+/13-, sign p=0.0006)
- graphic_devices=none: mean within-account diff +0.07 over 72 accts (32+/21-, sign p=0.169)
- text_contrast=medium: mean within-account diff -0.08 over 50 accts (13+/31-, sign p=0.0096)
- language_register=hype/promotional: mean within-account diff -0.08 over 51 accts (16+/29-, sign p=0.0725)
- cover_layout=product shot: mean within-account diff -0.11 over 26 accts (9+/10-, sign p=1.0)
- visual_source=stock-looking photo: mean within-account diff -0.11 over 26 accts (7+/17-, sign p=0.0639)
- graphic_devices=icons: mean within-account diff -0.09 over 37 accts (9+/18-, sign p=0.1221)
- logo_position=none: mean within-account diff +0.06 over 73 accts (27+/20-, sign p=0.3817)
- headline_size=huge: mean within-account diff +0.08 over 46 accts (28+/15-, sign p=0.066)
- cover_layout=full-bleed photo + overlaid headline: mean within-account diff +0.06 over 74 accts (37+/27-, sign p=0.2604)
- color_mood=dark: mean within-account diff -0.06 over 70 accts (21+/34-, sign p=0.1048)
- hook_type=product promo/offer: mean within-account diff -0.09 over 39 accts (14+/20-, sign p=0.3915)
- sentence_form=fragments/labels: mean within-account diff -0.06 over 74 accts (21+/37-, sign p=0.0479)
- human_face=False: mean within-account diff -0.06 over 71 accts (24+/35-, sign p=0.1925)
- caption_length=short (<125 chars): mean within-account diff -0.07 over 50 accts (11+/22-, sign p=0.0801)
- hook_type=number/list: mean within-account diff -0.09 over 33 accts (12+/18-, sign p=0.3616)
- text_contrast=high: mean within-account diff +0.06 over 77 accts (36+/17-, sign p=0.0127)
- language_register=conversational: mean within-account diff +0.06 over 73 accts (33+/27-, sign p=0.519)
- color_mood=brand-colour heavy: mean within-account diff +0.08 over 36 accts (18+/13-, sign p=0.4731)
- human_face=True: mean within-account diff +0.05 over 78 accts (35+/24-, sign p=0.1925)
- font_style=serif: mean within-account diff +0.10 over 21 accts (10+/7-, sign p=0.6291)
- graphic_devices=pills/badges: mean within-account diff -0.07 over 39 accts (10+/22-, sign p=0.0501)
- visual_source=screenshot: mean within-account diff -0.07 over 34 accts (11+/21-, sign p=0.1102)
- cover_layout=screenshot (tweet/news/app): mean within-account diff -0.09 over 19 accts (5+/14-, sign p=0.0636)
- hook_type=news/announcement: mean within-account diff +0.05 over 61 accts (34+/21-, sign p=0.1048)
- headline_size=small: mean within-account diff -0.06 over 44 accts (16+/22-, sign p=0.4177)
- font_style=sans-serif: mean within-account diff -0.04 over 70 accts (27+/23-, sign p=0.6718)
- visual_source=real photo: people: mean within-account diff +0.04 over 79 accts (35+/26-, sign p=0.3057)
- hook_type=question: mean within-account diff -0.05 over 47 accts (16+/26-, sign p=0.1641)
- cover_words: median(best-worst) 0 over 80 accts (30+/33-)
- slides: median(best-worst) 0 over 80 accts (23+/16-)
- words_per_interior_slide: median(best-worst) 10 over 1 accts (1+/0-)
### INDUSTRY B2B marketing / AI agency (accounts=14)
- logo_position=none: mean within-account diff +0.29 over 12 accts (8+/1-, sign p=0.0391)
- language_register=conversational: mean within-account diff +0.25 over 10 accts (7+/1-, sign p=0.0703)
- logo_position=top-left: mean within-account diff -0.26 over 9 accts (1+/7-, sign p=0.0703)
- color_mood=muted/neutral: mean within-account diff -0.21 over 11 accts (1+/8-, sign p=0.0391)
- font_style=handwritten/script: mean within-account diff +0.39 over 3 accts (3+/0-, sign p=0.25)
- font_style=sans-serif: mean within-account diff -0.20 over 11 accts (4+/6-, sign p=0.7539)
- color_mood=brand-colour heavy: mean within-account diff +0.24 over 7 accts (5+/1-, sign p=0.2188)
- headline_size=large: mean within-account diff -0.17 over 13 accts (2+/9-, sign p=0.0654)
- color_mood=photo-dominant: mean within-account diff +0.17 over 13 accts (8+/2-, sign p=0.1094)
- graphic_devices=icons: mean within-account diff -0.18 over 9 accts (1+/6-, sign p=0.125)
- headline_size=huge: mean within-account diff +0.17 over 10 accts (7+/1-, sign p=0.0703)
- hook_type=comparison: mean within-account diff +0.19 over 6 accts (4+/1-, sign p=0.375)
- language_register=neutral/informational: mean within-account diff -0.17 over 8 accts (2+/6-, sign p=0.2891)
- color_mood=dark: mean within-account diff -0.13 over 13 accts (4+/7-, sign p=0.5488)
- graphic_devices=boxes/cards: mean within-account diff -0.14 over 11 accts (2+/7-, sign p=0.1797)
- caption_length=short (<125 chars): mean within-account diff +0.17 over 7 accts (3+/1-, sign p=0.625)
- logo_position=centre: mean within-account diff -0.21 over 4 accts (0+/4-, sign p=0.125)
- visual_source=stock-looking photo: mean within-account diff -0.21 over 4 accts (1+/3-, sign p=0.625)
- cover_words: median(best-worst) 0 over 13 accts (3+/6-)
- slides: median(best-worst) 0 over 13 accts (3+/2-)
- words_per_interior_slide: median(best-worst) 10 over 1 accts (1+/0-)
### INDUSTRY Intimate apparel (accounts=22)
- cta=comment prompt: mean within-account diff +0.32 over 12 accts (11+/1-, sign p=0.0063)
- hook_type=none: mean within-account diff -0.33 over 7 accts (0+/7-, sign p=0.0156)
- caption_length=short (<125 chars): mean within-account diff -0.19 over 19 accts (1+/12-, sign p=0.0034)
- cta=none: mean within-account diff -0.18 over 19 accts (4+/12-, sign p=0.0768)
- sentence_form=mixed: mean within-account diff +0.18 over 16 accts (12+/2-, sign p=0.0129)
- cover_layout=product shot: mean within-account diff -0.16 over 18 accts (5+/7-, sign p=0.7744)
- caption_length=long (>600 chars): mean within-account diff +0.23 over 8 accts (8+/0-, sign p=0.0078)
- sentence_form=complete sentences: mean within-account diff -0.17 over 15 accts (4+/8-, sign p=0.3877)
- hook_type=story/narrative: mean within-account diff +0.18 over 13 accts (10+/1-, sign p=0.0117)
- color_mood=muted/neutral: mean within-account diff -0.13 over 19 accts (4+/8-, sign p=0.3877)
- headline_size=none: mean within-account diff -0.12 over 19 accts (3+/10-, sign p=0.0923)
- distinct_text_sizes=0: mean within-account diff -0.12 over 19 accts (3+/10-, sign p=0.0923)
- font_style=none: mean within-account diff -0.12 over 19 accts (3+/10-, sign p=0.0923)
- text_contrast=none: mean within-account diff -0.12 over 19 accts (3+/10-, sign p=0.0923)
- language_register=emotional/personal: mean within-account diff +0.14 over 12 accts (9+/2-, sign p=0.0654)
- text_contrast=high: mean within-account diff +0.11 over 18 accts (11+/4-, sign p=0.1185)
- color_mood=photo-dominant: mean within-account diff +0.12 over 12 accts (8+/4-, sign p=0.3877)
- cover_layout=full-bleed photo + overlaid headline: mean within-account diff +0.10 over 18 accts (10+/6-, sign p=0.4545)
- cover_words: median(best-worst) 0 over 19 accts (6+/5-)
- slides: median(best-worst) 0 over 19 accts (8+/5-)
### INDUSTRY Fintech / investing (Brazil) (accounts=13)
- font_style=condensed/display sans: mean within-account diff +0.29 over 8 accts (7+/1-, sign p=0.0703)
- font_style=sans-serif: mean within-account diff -0.24 over 12 accts (1+/7-, sign p=0.0703)
- distinct_text_sizes=4+: mean within-account diff -0.20 over 10 accts (3+/7-, sign p=0.3438)
- graphic_devices=other brands logos: mean within-account diff +0.21 over 7 accts (6+/1-, sign p=0.125)
- caption_length=long (>600 chars): mean within-account diff +0.15 over 11 accts (8+/3-, sign p=0.2266)
- font_style=serif: mean within-account diff +0.25 over 4 accts (3+/1-, sign p=0.625)
- font_style=serif+sans mix: mean within-account diff -0.28 over 3 accts (0+/3-, sign p=0.25)
- logo_position=none: mean within-account diff +0.14 over 12 accts (6+/3-, sign p=0.5078)
- headline_size=large: mean within-account diff -0.14 over 11 accts (3+/6-, sign p=0.5078)
- graphic_devices=pills/badges: mean within-account diff -0.17 over 7 accts (1+/5-, sign p=0.2188)
- caption_length=medium: mean within-account diff -0.12 over 12 accts (4+/7-, sign p=0.5488)
- cta=save/share: mean within-account diff +0.21 over 4 accts (3+/1-, sign p=0.625)
- visual_source=stock-looking photo: mean within-account diff -0.17 over 6 accts (1+/4-, sign p=0.375)
- color_mood=photo-dominant: mean within-account diff +0.12 over 11 accts (5+/4-, sign p=1.0)
- language_register=conversational: mean within-account diff +0.12 over 11 accts (6+/2-, sign p=0.2891)
- headline_size=huge: mean within-account diff +0.13 over 9 accts (7+/2-, sign p=0.1797)
- cover_layout=text-only plate: mean within-account diff -0.14 over 7 accts (1+/5-, sign p=0.2188)
- headline_size=small: mean within-account diff -0.14 over 7 accts (1+/5-, sign p=0.2188)
- cover_words: median(best-worst) -1 over 12 accts (4+/7-)
- slides: median(best-worst) 0 over 12 accts (2+/3-)
### INDUSTRY Tech news media (Hebrew) (accounts=12)
- color_mood=photo-dominant: mean within-account diff +0.27 over 11 accts (10+/1-, sign p=0.0117)
- format=reel: mean within-account diff -0.27 over 10 accts (2+/8-, sign p=0.1094)
- graphic_devices=other brands logos: mean within-account diff -0.26 over 9 accts (2+/7-, sign p=0.1797)
- text_contrast=medium: mean within-account diff -0.27 over 8 accts (0+/8-, sign p=0.0078)
- caption_length=short (<125 chars): mean within-account diff -0.26 over 7 accts (1+/5-, sign p=0.2188)
- hook_type=how-to/guide: mean within-account diff -0.33 over 4 accts (0+/4-, sign p=0.125)
- visual_source=real photo: product/object: mean within-account diff +0.24 over 7 accts (5+/1-, sign p=0.2188)
- caption_length=medium: mean within-account diff +0.18 over 11 accts (6+/1-, sign p=0.125)
- visual_source=illustration/vector: mean within-account diff -0.21 over 8 accts (1+/6-, sign p=0.125)
- graphic_devices=stickers/emoji: mean within-account diff +0.29 over 4 accts (3+/1-, sign p=0.625)
- graphic_devices=big number/stat: mean within-account diff +0.33 over 3 accts (3+/0-, sign p=0.25)
- text_contrast=high: mean within-account diff +0.15 over 12 accts (6+/0-, sign p=0.0312)
- headline_size=small: mean within-account diff -0.23 over 5 accts (1+/4-, sign p=0.375)
- headline_size=large: mean within-account diff +0.15 over 11 accts (8+/2-, sign p=0.1094)
- format=carousel: mean within-account diff +0.17 over 9 accts (5+/3-, sign p=0.7266)
- color_mood=dark: mean within-account diff -0.14 over 12 accts (1+/9-, sign p=0.0215)
- color_mood=muted/neutral: mean within-account diff -0.15 over 10 accts (0+/8-, sign p=0.0078)
- hook_type=news/announcement: mean within-account diff +0.14 over 11 accts (8+/2-, sign p=0.1094)
- cover_words: median(best-worst) 3 over 12 accts (9+/2-)
- slides: median(best-worst) 0 over 12 accts (4+/1-)
### INDUSTRY Creator economy / city-guide app (accounts=13)
- language_register=hype/promotional: mean within-account diff -0.33 over 6 accts (1+/5-, sign p=0.2188)
- headline_size=huge: mean within-account diff +0.33 over 5 accts (4+/1-, sign p=0.375)
- headline_size=large: mean within-account diff -0.25 over 8 accts (1+/6-, sign p=0.125)
- hook_type=story/narrative: mean within-account diff +0.25 over 8 accts (6+/1-, sign p=0.125)
- cta=comment prompt: mean within-account diff +0.25 over 8 accts (7+/1-, sign p=0.0703)
- hook_type=product promo/offer: mean within-account diff -0.29 over 4 accts (1+/3-, sign p=0.625)
- color_mood=dark: mean within-account diff -0.21 over 7 accts (0+/5-, sign p=0.0625)
- cta=link in bio/shop: mean within-account diff -0.22 over 6 accts (1+/5-, sign p=0.2188)
- graphic_devices=pills/badges: mean within-account diff -0.19 over 7 accts (1+/6-, sign p=0.125)
- graphic_devices=icons: mean within-account diff -0.25 over 4 accts (0+/3-, sign p=0.25)
- language_register=emotional/personal: mean within-account diff +0.19 over 6 accts (5+/0-, sign p=0.0625)
- logo_position=top-left: mean within-account diff -0.19 over 6 accts (1+/5-, sign p=0.2188)
- cta=save/share: mean within-account diff -0.20 over 5 accts (0+/3-, sign p=0.25)
- color_mood=photo-dominant: mean within-account diff +0.17 over 7 accts (4+/1-, sign p=0.375)
- hook_type=number/list: mean within-account diff -0.17 over 7 accts (3+/4-, sign p=1.0)
- headline_size=none: mean within-account diff +0.15 over 8 accts (6+/2-, sign p=0.2891)
- font_style=none: mean within-account diff +0.15 over 8 accts (6+/2-, sign p=0.2891)
- language_register=neutral/informational: mean within-account diff -0.17 over 6 accts (0+/5-, sign p=0.0625)
- cover_words: median(best-worst) -1 over 11 accts (4+/6-)
- slides: median(best-worst) 0 over 11 accts (3+/2-)
### INDUSTRY Startup / founder programs (accounts=13)
- graphic_devices=none: mean within-account diff +0.36 over 11 accts (8+/0-, sign p=0.0078)
- cta=link in bio/shop: mean within-account diff -0.30 over 9 accts (2+/7-, sign p=0.1797)
- font_style=condensed/display sans: mean within-account diff -0.23 over 10 accts (0+/9-, sign p=0.0039)
- graphic_devices=boxes/cards: mean within-account diff -0.26 over 7 accts (2+/5-, sign p=0.4531)
- cta=none: mean within-account diff +0.17 over 13 accts (7+/4-, sign p=0.5488)
- language_register=neutral/informational: mean within-account diff -0.18 over 10 accts (1+/6-, sign p=0.125)
- color_mood=muted/neutral: mean within-account diff -0.17 over 12 accts (4+/7-, sign p=0.5488)
- visual_source=real photo: place/scene: mean within-account diff +0.21 over 7 accts (5+/2-, sign p=0.4531)
- cover_layout=full-bleed photo + overlaid headline: mean within-account diff +0.17 over 11 accts (8+/2-, sign p=0.1094)
- distinct_text_sizes=4+: mean within-account diff -0.22 over 6 accts (0+/5-, sign p=0.0625)
- logo_position=centre: mean within-account diff +0.23 over 5 accts (5+/0-, sign p=0.0625)
- graphic_devices=icons: mean within-account diff -0.23 over 5 accts (0+/4-, sign p=0.125)
- visual_source=real photo: people: mean within-account diff +0.14 over 13 accts (8+/4-, sign p=0.3877)
- headline_size=none: mean within-account diff +0.19 over 6 accts (4+/1-, sign p=0.375)
- font_style=none: mean within-account diff +0.20 over 5 accts (3+/0-, sign p=0.25)
- visual_source=stock-looking photo: mean within-account diff -0.20 over 5 accts (0+/5-, sign p=0.0625)
- graphic_devices=pills/badges: mean within-account diff -0.20 over 5 accts (1+/4-, sign p=0.375)
- cover_layout=person/face video frame: mean within-account diff -0.15 over 9 accts (4+/5-, sign p=1.0)
- cover_words: median(best-worst) -2 over 13 accts (4+/7-)
- slides: median(best-worst) 0 over 13 accts (3+/3-)
### INDUSTRY ADVANCEMENT PROFILE
- B2B marketing / AI agency: {"accounts": 14, "mean_craft": 3.29, "median_er_pct": 0.279, "best_layout_entropy_bits": 3.11, "best_posts": 78, "top_layouts": [["full-bleed photo + overlaid headline", 24], ["photo block + text on plain ground", 11], ["collage/multi-photo", 9], ["illustration/graphic-led", 7]], "top_devices": [["boxes/cards", 19], ["pills/badges", 19], ["other brands logos", 13], ["highlight/underline", 10], ["icons", 7], ["arrows/lines", 4]], "top_visual_sources": [["real photo: people", 52], ["illustration/vector", 18], ["real photo: product/object", 15], ["icons", 8], ["screenshot", 8]], "best_formats": [["reel", 43], ["carousel", 27], ["image", 8]], "top_craft_accounts": [["karoslabs", 4], ["sintra.ai", 4], ["peoplebrandsandthings", 4], ["orenmeetsworld", 4], ["thebrandblueprint_", 4]]}
- Intimate apparel: {"accounts": 22, "mean_craft": 3.3, "median_er_pct": 0.026, "best_layout_entropy_bits": 2.72, "best_posts": 114, "top_layouts": [["product shot", 30], ["person/face video frame", 27], ["full-bleed photo + overlaid headline", 25], ["other", 11]], "top_devices": [["boxes/cards", 11], ["other brands logos", 5], ["hand-drawn marks", 4], ["stickers/emoji", 3], ["numbered markers", 3], ["pills/badges", 3]], "top_visual_sources": [["real photo: people", 80], ["real photo: product/object", 32], ["real photo: place/scene", 13], ["stock-looking photo", 4], ["screenshot", 4]], "best_formats": [["carousel", 49], ["reel", 49], ["image", 16]], "top_craft_accounts": [["aerie", 4], ["meundies", 4], ["thirdlove", 4], ["savagexfenty", 4], ["skims", 4]]}
- Fintech / investing (Brazil): {"accounts": 13, "mean_craft": 3.08, "median_er_pct": 0.052, "best_layout_entropy_bits": 2.92, "best_posts": 72, "top_layouts": [["full-bleed photo + overlaid headline", 21], ["person/face video frame", 16], ["collage/multi-photo", 8], ["illustration/graphic-led", 6]], "top_devices": [["boxes/cards", 22], ["icons", 12], ["other brands logos", 11], ["highlight/underline", 9], ["pills/badges", 9], ["big number/stat", 8]], "top_visual_sources": [["real photo: people", 49], ["illustration/vector", 11], ["none (type only)", 7], ["icons", 7], ["real photo: place/scene", 6]], "best_formats": [["reel", 45], ["carousel", 16], ["image", 11]], "top_craft_accounts": [["invistainco", 4], ["infomoney", 4], ["gustavocerbasi", 4], ["xodigital.oficial", 3], ["tokeniza.com.br", 3]]}
- Tech news media (Hebrew): {"accounts": 12, "mean_craft": 3.38, "median_er_pct": 0.187, "best_layout_entropy_bits": 2.67, "best_posts": 72, "top_layouts": [["full-bleed photo + overlaid headline", 27], ["photo block + text on plain ground", 10], ["split photo/text", 9], ["person/face video frame", 8]], "top_devices": [["boxes/cards", 14], ["pills/badges", 12], ["other brands logos", 9], ["stickers/emoji", 9], ["icons", 8], ["big number/stat", 7]], "top_visual_sources": [["real photo: people", 49], ["real photo: product/object", 15], ["real photo: place/scene", 13], ["illustration/vector", 8], ["AI-generated-looking image", 5]], "best_formats": [["image", 33], ["carousel", 27], ["reel", 12]], "top_craft_accounts": [["wired", 5], ["themarker_online", 4], ["morningbrew", 4], ["evolving.ai", 4], ["visualcap", 4]]}
- Creator economy / city-guide app: {"accounts": 13, "mean_craft": 3.31, "median_er_pct": 0.19, "best_layout_entropy_bits": 2.05, "best_posts": 71, "top_layouts": [["full-bleed photo + overlaid headline", 39], ["other", 13], ["product shot", 6], ["person/face video frame", 6]], "top_devices": [["boxes/cards", 11], ["arrows/lines", 5], ["pills/badges", 5], ["big number/stat", 5], ["stickers/emoji", 4], ["numbered markers", 4]], "top_visual_sources": [["real photo: place/scene", 41], ["real photo: people", 28], ["real photo: product/object", 18], ["stock-looking photo", 3], ["screenshot", 2]], "best_formats": [["reel", 38], ["carousel", 30], ["image", 3]], "top_craft_accounts": [["mindtrip.ai", 4], ["wherethefuckdowego", 4], ["mapstr", 4], ["infatuation", 4], ["stanforcreators", 4]]}
- Startup / founder programs: {"accounts": 13, "mean_craft": 3.27, "median_er_pct": 0.288, "best_layout_entropy_bits": 2.74, "best_posts": 78, "top_layouts": [["full-bleed photo + overlaid headline", 26], ["quote card", 12], ["person/face video frame", 11], ["split photo/text", 9]], "top_devices": [["other brands logos", 13], ["highlight/underline", 12], ["boxes/cards", 11], ["icons", 6], ["pills/badges", 4], ["hand-drawn marks", 2]], "top_visual_sources": [["real photo: people", 60], ["real photo: place/scene", 17], ["none (type only)", 11], ["real photo: product/object", 3], ["illustration/vector", 2]], "best_formats": [["reel", 37], ["carousel", 24], ["image", 17]], "top_craft_accounts": [["deelpitch", 4], ["join_ef", 4], ["founderspodcast", 4], ["a16z", 4], ["sahilbloom", 4]]}
### TRANSFER CANDIDATES (strong+consistent in source, rare in target)
- cta=comment prompt: Intimate apparel (diff +0.32, 12 accts, 11+/1-) -> Fintech / investing (Brazil) (prevalence 0.111, 0.083 over 4 accts)
- cta=comment prompt: Intimate apparel (diff +0.32, 12 accts, 11+/1-) -> Startup / founder programs (prevalence 0.103, -0.083 over 8 accts)
- color_mood=photo-dominant: Tech news media (Hebrew) (diff +0.27, 11 accts, 10+/1-) -> Intimate apparel (prevalence 0.136, 0.125 over 12 accts)
- font_style=condensed/display sans: Fintech / investing (Brazil) (diff +0.29, 8 accts, 7+/1-) -> Intimate apparel (prevalence 0.057, 0.028 over 6 accts)
- headline_size=huge: Creator economy / city-guide app (diff +0.33, 5 accts, 4+/1-) -> Intimate apparel (prevalence 0.044, 0.0 over 7 accts)
- headline_size=huge: Creator economy / city-guide app (diff +0.33, 5 accts, 4+/1-) -> Fintech / investing (Brazil) (prevalence 0.132, 0.13 over 9 accts)
- headline_size=huge: Creator economy / city-guide app (diff +0.33, 5 accts, 4+/1-) -> Tech news media (Hebrew) (prevalence 0.125, -0.095 over 7 accts)
- headline_size=huge: Creator economy / city-guide app (diff +0.33, 5 accts, 4+/1-) -> Startup / founder programs (prevalence 0.122, -0.021 over 8 accts)
- sentence_form=mixed: Intimate apparel (diff +0.18, 16 accts, 12+/2-) -> Creator economy / city-guide app (prevalence 0.109, 0.167 over 5 accts)
- hook_type=story/narrative: Creator economy / city-guide app (diff +0.25, 8 accts, 6+/1-) -> B2B marketing / AI agency (prevalence 0.077, -0.056 over 6 accts)
- hook_type=story/narrative: Creator economy / city-guide app (diff +0.25, 8 accts, 6+/1-) -> Intimate apparel (prevalence 0.114, 0.179 over 13 accts)
- hook_type=story/narrative: Creator economy / city-guide app (diff +0.25, 8 accts, 6+/1-) -> Fintech / investing (Brazil) (prevalence 0.069, 0.056 over 6 accts)
- hook_type=story/narrative: Creator economy / city-guide app (diff +0.25, 8 accts, 6+/1-) -> Tech news media (Hebrew) (prevalence 0.104, -0.021 over 8 accts)
- cta=comment prompt: Creator economy / city-guide app (diff +0.25, 8 accts, 7+/1-) -> Intimate apparel (prevalence 0.145, 0.319 over 12 accts)
- cta=comment prompt: Creator economy / city-guide app (diff +0.25, 8 accts, 7+/1-) -> Fintech / investing (Brazil) (prevalence 0.111, 0.083 over 4 accts)
- cta=comment prompt: Creator economy / city-guide app (diff +0.25, 8 accts, 7+/1-) -> Startup / founder programs (prevalence 0.103, -0.083 over 8 accts)
- hook_type=story/narrative: Intimate apparel (diff +0.18, 13 accts, 10+/1-) -> B2B marketing / AI agency (prevalence 0.077, -0.056 over 6 accts)
- hook_type=story/narrative: Intimate apparel (diff +0.18, 13 accts, 10+/1-) -> Fintech / investing (Brazil) (prevalence 0.069, 0.056 over 6 accts)
- hook_type=story/narrative: Intimate apparel (diff +0.18, 13 accts, 10+/1-) -> Tech news media (Hebrew) (prevalence 0.104, -0.021 over 8 accts)
- hook_type=story/narrative: Intimate apparel (diff +0.18, 13 accts, 10+/1-) -> Creator economy / city-guide app (prevalence 0.146, 0.25 over 8 accts)
- color_mood=brand-colour heavy: B2B marketing / AI agency (diff +0.24, 7 accts, 5+/1-) -> Intimate apparel (prevalence 0.026, 0.167 over 4 accts)
- color_mood=brand-colour heavy: B2B marketing / AI agency (diff +0.24, 7 accts, 5+/1-) -> Fintech / investing (Brazil) (prevalence 0.139, -0.042 over 8 accts)
- color_mood=brand-colour heavy: B2B marketing / AI agency (diff +0.24, 7 accts, 5+/1-) -> Tech news media (Hebrew) (prevalence 0.104, 0.071 over 7 accts)
- color_mood=brand-colour heavy: B2B marketing / AI agency (diff +0.24, 7 accts, 5+/1-) -> Creator economy / city-guide app (prevalence 0.058, untested there)
- color_mood=brand-colour heavy: B2B marketing / AI agency (diff +0.24, 7 accts, 5+/1-) -> Startup / founder programs (prevalence 0.147, 0.062 over 8 accts)
- visual_source=real photo: product/object: Tech news media (Hebrew) (diff +0.24, 7 accts, 5+/1-) -> Fintech / investing (Brazil) (prevalence 0.056, -0.0 over 5 accts)
- visual_source=real photo: product/object: Tech news media (Hebrew) (diff +0.24, 7 accts, 5+/1-) -> Startup / founder programs (prevalence 0.032, 0.042 over 4 accts)
- color_mood=photo-dominant: B2B marketing / AI agency (diff +0.17, 13 accts, 8+/2-) -> Intimate apparel (prevalence 0.136, 0.125 over 12 accts)
- graphic_devices=stickers/emoji: Tech news media (Hebrew) (diff +0.29, 4 accts, 3+/1-) -> B2B marketing / AI agency (prevalence 0.032, 0.042 over 4 accts)
- graphic_devices=stickers/emoji: Tech news media (Hebrew) (diff +0.29, 4 accts, 3+/1-) -> Intimate apparel (prevalence 0.039, -0.083 over 6 accts)
- graphic_devices=stickers/emoji: Tech news media (Hebrew) (diff +0.29, 4 accts, 3+/1-) -> Fintech / investing (Brazil) (prevalence 0.007, untested there)
- graphic_devices=stickers/emoji: Tech news media (Hebrew) (diff +0.29, 4 accts, 3+/1-) -> Creator economy / city-guide app (prevalence 0.044, 0.083 over 4 accts)
- graphic_devices=stickers/emoji: Tech news media (Hebrew) (diff +0.29, 4 accts, 3+/1-) -> Startup / founder programs (prevalence 0.019, untested there)
- graphic_devices=other brands logos: Fintech / investing (Brazil) (diff +0.21, 7 accts, 6+/1-) -> Intimate apparel (prevalence 0.022, 0.208 over 4 accts)
- graphic_devices=other brands logos: Fintech / investing (Brazil) (diff +0.21, 7 accts, 6+/1-) -> Creator economy / city-guide app (prevalence 0.015, untested there)
- visual_source=real photo: place/scene: Startup / founder programs (diff +0.21, 7 accts, 5+/2-) -> Intimate apparel (prevalence 0.14, -0.1 over 10 accts)
- visual_source=real photo: place/scene: Startup / founder programs (diff +0.21, 7 accts, 5+/2-) -> Fintech / investing (Brazil) (prevalence 0.097, -0.042 over 8 accts)
- headline_size=huge: B2B marketing / AI agency (diff +0.17, 10 accts, 7+/1-) -> Intimate apparel (prevalence 0.044, 0.0 over 7 accts)
- headline_size=huge: B2B marketing / AI agency (diff +0.17, 10 accts, 7+/1-) -> Fintech / investing (Brazil) (prevalence 0.132, 0.13 over 9 accts)
- headline_size=huge: B2B marketing / AI agency (diff +0.17, 10 accts, 7+/1-) -> Tech news media (Hebrew) (prevalence 0.125, -0.095 over 7 accts)

## Client synthesis: xodigital

**Best creators**

- @nathfinancas: Best rule-change explainers in the set. Its N3.Notícias law carousels took the two largest multiples in Brazilian finance: x31.5 (vale-alimentação) and x26.75 (Taxa Rosa). The cover states the new rule as a complete sentence over a photo of the thing itself (a card machine, real price tags), with a colour scrim and a category pill. Inside, white and blue slides alternate, each with one 2-line headline, one body block and an arrow icon. A 'Mas atenção:' slide comes before the action step, and the pitch arrives last in small type. It is the same kind of topic as our CVM post, done the way ours should have been. Its own sales template holds 5 of its 6 worst slots (x0.04 to x0.10).
- @invistainco: The closest direct competitor with carousel formats it repeats. The first is one named investor's real portfolio (x3.42): 441 operations, then the late payments shown first (11 of 441), then 98,78% paid on time, the 219,91% return held for the last slide, and the risk line as the closing sentence. The second is a 2-slide monthly payments report (x2.12, 8 comments): a branded cover plus one chart and R$ 1.022.164.167,74. Stat pills in brand colours do the graphic work. Its abstract process explainers and internal posts are its floor (x0.12 to x0.5).
- @xodigital.oficial: The client's own feed. Its capybara mascot reels are the only XO content that reaches non-followers: 9,902, 5,433 and 2,841 views against 136 and 142 for the branded reels, on 385 followers. Its 'O que é a XO Digital?' carousel (x2.33) is the only carousel above a flat 5-to-18-like band, and it sets the house system: navy and cream slides alternating, a heavy two-tone headline with a gold second line, mono eyebrows, 01/02/03 rows, CVM code badges, a WhatsApp mockup, and a close with CTA plus risk line.
- @tokeniza.com.br: Shows a tokenization platform getting lift from regulators and big names. 'A CVM criou um grupo de trabalho só para tokenização' (x2.0) is a single card with a two-tone headline and an illustrated document graphic. The Binance-founder carousel (x2.25) runs one fact per slide on a fixed template, with the disclaimer only on the last slide. It is also a warning: its market-size and self-proof stat cards (684 ativos / R$ 6,87 bi, the EY audit, +9.000 cadastros) all sit at x0.62.
- @infomoney: Carousel craft at scale: 13 of its 14 outliers are carousels. Every cover headline is a complete sentence on a bottom card with a tag pill. The payoff comes fast: B1 is a hook, then a map that explains itself (x18.01). Closes are dense document or spec plates, never recaps. The #DataIM ranked logo list (x4.53) carries its information as a graphic.
- @mepoupenaweb: A pacing model. The 15-slide decades carousel (x28.35) keeps one layout, one pill and one fact of 30 to 38 words per slide. B4 (x8.17) pairs named real businesswomen with ~8-word 'trait + result' captions and saves its single CTA for a branded closing card. Its own flat-colour meme template with generic questions is its floor (x0.12 to x0.37).
- @mariliadfontes: Cover discipline. Every best post states one quantified claim in about 11 to 15 words, e.g. R$ 9,1 tri em renda fixa (x5.68) and 'queda da Selic favorece prefixados' (x2.63). The identical CNN format drops to x0.18 when it stacks three text layers over a vague topic.
- @hurst.capital: What works here is a host on camera plus a named product with hard terms: a streaming credit line at 23% a.a. with a R$ 30 mil minimum (x3.39). Its fully on-brand dark-and-gold carousels that open on abstract questions never reach outlier status (0 of 13, floor x0.61). That is a direct warning for XO's navy-and-gold branded explainers.
- @gustavocerbasi: Proof that the plainest execution wins when the idea is complete. A typographic quote card is its x36.25 outlier. The 12-slide purchase checklist (x7.1) uses one headline size and one body size across every slide. Sales and partner assets set in a different hand fill all six of its worst slots.

**Best content**

- @xodigital.oficial https://www.instagram.com/p/DcwSwnyxXsu/: x36.78: 313 likes and 9,902 views on a 385-follower account. The client's own capybara in sunglasses sits on a cloud with a coconut, with no text on the image. The caption opens with a POV joke ('Nível de estresse atual: capivara…') and follows with one product line (recebíveis, WhatsApp, XOdó). An owned character carries a relatable feeling, and the pitch stays in the caption.
- @xodigital.oficial https://www.instagram.com/p/DdmQQ6JG6Rc/: x2.33, the only XO carousel that breaks out, and the reference for the house system. Navy (≈#072443) and cream (≈#f3ecdc) alternate every slide. Headlines are two lines in a heavy geometric sans, split two-tone with the second line in gold, and end with a period. Mono footer eyebrows, 01/02/03 rows, outlined CVM code badges and a WhatsApp XOdó mockup carry the detail. The spine runs question, mechanism, CVM, guarantees, product proof, CTA plus risk line. The cover answers its own question in one line.
- @xodigital.oficial https://www.instagram.com/p/DcRYkUKI0sK/: x1.89 and 2 comments, XO's best static post. Third-party proof (Startupz coverage) appears as a phone mockup of the article, with three white stat pills with round icons on cream: R$ 6,5 mi distribuídos, R$ 50 mi meta 2027, +100 investidores. It combines outside authority with numbers shown as graphics, all in the client's own devices.
- @invistainco https://www.instagram.com/p/DdkETZjDg5_/: x3.42. The cover names a real investor with an attributed number ('Mais de 400 investimentos', his portrait under a dark vignette). Stat pills (441 / 115 / +300) alternate with light video-still slides. The late payments are disclosed first (11 of 441, 2,49%) before 98,78% on time. The last slide holds the two biggest numbers (219,91% / 221% do CDI), and the risk line is the final sentence.
- @invistainco https://www.instagram.com/p/DdRZzrKIG2q/: x2.12 with 8 comments. A monthly proof-of-payment report in two slides: a branded title card ('Agosto na INCO'), then one line chart (97,7% paid, 2,3% late) and one headline number (R$ 1.022.164.167,74 repassados). XO can copy the format directly with its own figures.
- @tokeniza.com.br https://www.instagram.com/p/DdL8E4ulcNj/: x2.0. The closest analogue to our CVM post, done as one card. A NOTÍCIA pill sits over a complete-sentence headline ('A CVM criou um grupo de trabalho só para tokenização.') with the key words in the accent colour. An illustrated document or folder graphic stands in for a photo, and two short body lines follow. The regulator is named in text and its logo is not used as decoration.
- @tokeniza.com.br https://www.instagram.com/p/DdjHVv-m66s/: x2.25. A big-name claim leads ('Fundador da Binance: os IPOs do futuro serão em blockchain'). Five slides use an identical layout (bold headline, grey support line, green edge bar, dot pagination) with 19 to 23 words each. Specificity builds from a quote to US$ 2,9 bi on-chain to NYSE approval. The last slide turns to Brazil and the CVM and is the only one carrying the disclaimer.
- @nathfinancas https://www.instagram.com/p/DdmY7ozFjf0/: x31.5. The cover is a photo of a card machine with a blue scrim, a DIREITO pill and the rule stated in the second person with its date ('Seu vale-alimentação vai passar em qualquer maquininha a partir de novembro.'). Slides answer 'O que está mudando?', then the decree number and the 3,6% cap, then 'Quem ganha e o que continua igual?', and end on save/share with a small plug. Each slide has one headline, one body block with 2 or 3 bolded facts, and an arrow.
- @nathfinancas https://www.instagram.com/p/DcweLRXlk-S/: x26.75. Same template, and the cover photo is the evidence itself: price tags reading R$ 4,15 and R$ 5,48. It adds the credibility beat our CVM post lacked: slide 4 'Mas atenção:' explains that the penalty clause was vetoed, and slide 5 gives the reader an action ('exija o preço igual e denuncie ao Procon').
- @infomoney https://www.instagram.com/p/DdpcLBlDH_T/: x18.01 with 2,086 comments. Two slides only: a 14-word complete-sentence headline over a photo block, then a map with every country marked took part or didn't. The graphic is the whole answer, and nothing is repeated.
- @mepoupenaweb https://www.instagram.com/p/DdCZ-Oxn1Wf/: x28.35. A cover with a direct claim and no question mark ('Você acha normal ser dona do próprio dinheiro. Nem sempre foi.'), then one decade per slide. Each slide carries one pill and one dense fact (30 to 38 words) on an identical plate. The metronomic, repetition-free pacing keeps 15 slides swipeable.
- @mariliadfontes https://www.instagram.com/p/DdbtXXkDDt7/: x5.68 and 67K views. One quantified claim on a black plate in the lower third ('RENDA FIXA É PREFERÊNCIA DOS BRASILEIROS', R$ 9,1 trilhões), readable in under two seconds. The long caption does the explaining. Her 'queda da Selic pode favorecer títulos prefixados' (DdcFJRrlLDK, x2.63) is the same move applied to prefixed fixed income, which is XO's product.
- @hurst.capital https://www.instagram.com/p/DbHD1BLicKT/: x3.39. A staff member on camera presents one named credit product with hard terms (fixed rate, minimum ticket) rather than a category. All 4 Hurst outliers follow this 'person plus specific product' formula, while its 13 templated carousels never reach outlier status.

**Patterns**

- [high] (hook) Covers win by stating the reader's stake as one concrete, checkable claim tied to something named: a rule with its date, a product with its rate and minimum, a named person with a number, or a named institution. Covers built on an abstract concept or a process description form the floor. Evidence: Nath x31.5 ('Seu vale-alimentação vai passar em qualquer maquininha a partir de novembro.') and x26.75. INCO x3.42 (named investor, 441 operations) and x2.12 (R$ 1.022.164.167,74 repassados). Hurst x3.39 (named credit line, 23% a.a., R$ 30 mil minimum). Tokeniza B5 'Um carro custa R$ 1,5 milhão' x2.25 against W6 on the identical interview set with an open question, x0.62. Floors: INCO process explainers W3/W4/W6 x0.25-0.5; Hurst's four abstract-question carousels x0.61; Liqi's six definitional explainers x0.22-0.44; EqSeed's evergreen explainer reels pinned at x0.35.
- [medium] (hook) Market-size and macro statistics, and listicle counts, do not work as hooks for platforms. A number has to be about the reader's own money or decision. Evidence: Tokeniza W4 (684 ativos tokenizados / R$ 6,87 bi em 2026) x0.62. XO W4 (títulos privados 8%→20%) x0.67 and XO's FIDC-record carousel x0.78. EqSeed W4 (capital markets overtook banks) x0.35. GCB W5 (agro +6,8%) x0.5. hook_type number/list is on 5.6% of best vs 11.1% of weakest (lift 0.56): XO '3 ofertas no ar.' x0.56, Hurst's 'two ways to invest in oil' and 'three assets to watch' x0.61. The one counter-case, Marília x5.68 (R$ 9,1 tri), is a known CNN host framing what 'brasileiros' choose.
- [high] (other) Borrowed authority lifts posts: a regulator, exchange, press outlet, event or named guest as the subject beats a platform's claims about itself. Evidence: Other brands' logos appear on 15.3% of best vs 2.8% of weakest (lift 4, n=72 each). Tokeniza's best posts ride Mercado Bitcoin/Fenasbac, Binance plus the NYSE, and the CVM (x2.0-x4.12), while its self-proof cards (EY audit, +9.000 cadastros) sit at x0.62. EqSeed's top 4 are Rio Innovation Week (x11.88 image). 4 of Liqi's 6 best are Token Summit (Banco Central, CVM) or Expert XP. 4 of GCB's 6 best are Futurum Talks guests. XO's best static post is its Startupz press post (x1.89, 2 comments).
- [medium] (format) XO's reach comes only from capybara mascot reels. Its carousels and images are statistically flat, so carousel rules for XO must be borrowed from accounts large enough to separate signal from noise. Evidence: 3 capybara reels: x36.78 (313 likes / 9,902 views), x12.11 (109 / 5,433), x3.33 (30 / 2,841). XO's 2 branded reels drew 136 and 142 views. The 15 non-pinned carousels range from 5 to 18 likes (median 8), and images from 4 to 14 (median 9); only 'O que é a XO Digital?' (18 likes) separates. Caveats: n=3, B2 carried a vodka giveaway, and the base is tiny (385 followers, median engagement 9).
- [medium] (language) Headlines that work are complete declarative sentences, or one precise question answered on the cover, in a conversational register. Fragments, hype and abstract labels fail. Evidence: language_register conversational: 30.6% of best vs 19.4% of weakest (lift 1.53). hype/promotional: 6.9% vs 13.9% (lift 0.55). Every InfoMoney outlier cover headline is a complete sentence. Nath states the rule as settled fact. XO's breakout headlines are short complete statements ('Seu dinheiro financia a economia real.', 'Autorizada pela CVM.'). Failures: Me Poupe W2 'Mulheres são…' x0.2; XO W6 'O caminho do seu dinheiro no crédito privado' x0.78; Marília W4 4-word masthead x0.14.
- [medium] (language) Stating the catch before the reassurance builds credibility, and both top explainer formats do it. Evidence: Nath x26.75 puts 'Mas atenção:' (the penalty clause was vetoed) before the action step. INCO x3.42 opens its data slide with '11 de 441 operações em atraso' (2,49% / 1,34%) before showing 98,78% on time, and closes on 'Investir envolve riscos…'.
- [high] (layout) Winning carousels keep one fixed layout for every interior slide: one headline of at most 2 lines, one body block, one recurring pacing device. Only the content changes from slide to slide. Evidence: Me Poupe x28.35: 15 slides, same pill, plate and sizes. Tokeniza x2.25: 5 identical slides with edge bar and dot pagination. Nath x31.5/x26.75: white and blue alternating, 2-line headline plus body plus arrow. Cerbasi x7.1: one headline box and one body box across 10 photos. XO x2.33: navy and cream alternating with a two-tone 2-line headline on all 6 slides.
- [medium] (font sizes) Hold three text sizes at most. Headlines should be heavy and never small. The damage comes from the spread between huge and tiny type, not from big type as such. Evidence: distinct_text_sizes 4+: 30.6% of weakest vs 13.9% of best (lift 0.48); exactly 2 sizes: 26.4% vs 18.1%. headline_size small: 12.5% vs 4.2%; huge: 18.1% vs 8.3%. Condensed/display (heavy) sans: 25% vs 5.6% (lift 3.8). Measured on XO's breakout carousel: headline ≈5.5% of slide height per line (≈8% on the cover), body ≈2.6%, mono labels ≈1.8%, i.e. 3 sizes.
- [high] (design) Keep covers short, around 12 words or fewer. Interior slides can carry about 33 words as long as each slide adds a fact no other slide has. Evidence: cover_words median: 9.5 on best vs 13 on weakest (n=72 each). Marília's winning plates run ~11-15 words; her losers run 36-53. GCB's densest cover ('Agro em números') x0.5. Me Poupe W4's ~80-word cover x0.34. Best carousels average a median of 33 words per interior slide (n=13), and Nath's law explainers run 50-80 because every slide answers a new question.
- [high] (imagery) Stock-looking photos and screenshots cluster among weak posts. Photos win when they show the actual subject, and text over a photo always sits on a scrim. Evidence: stock-looking photo: 11.1% of weakest vs 2.8% of best (lift 0.33). screenshot: 12.5% vs 4.2% (lift 0.4). Wins: Nath's photos are the price tags and the card machine themselves (x26.75/x31.5); INCO shows its named investor under a dark vignette (x3.42); Tokeniza's candid event photo x4.12. Failures: XO W1 (stock/AI man with a hologram) is XO's worst at x0.44; Hurst W1 (five text elements on a lifestyle photo) x0.54; INCO W3 (green headline on a busy photo without a scrim) x0.25.
- [medium] (imagery) AI imagery works only as an owned character with a joke. As generic scenery it fails. Evidence: 'AI-generated-looking' visuals are on 6.9% of best (5) vs 0% of weakest, but at least 3 of those 5 are XO's capybara reels. XO's generic AI/stock scene (W1, man touching a hologram) is its worst post at x0.44.
- [medium] (graphics) Numbers shown as graphics (charts, maps, ranked logos, stat pills with icons, illustrated documents) over-index among best posts. Evidence: chart/table/data-graphic covers: 6.9% of best vs 1.4% of weakest (lift 3). Icons: 9.7% vs 2.8% (lift 2.67). Illustration/vector: 15.3% vs 9.7%. Examples: INCO's payments line chart (x2.12) and stat pills (x3.42); InfoMoney's map payoff (x18.01) and #DataIM ranked logos (x4.53); Tokeniza's illustrated working-group folder (x2.0); XO's stat pills with round icons (x1.89).
- [medium] (graphics) Decorative template furniture (pills, badges, rules, text-only plates) does nothing unless it carries a concrete fact. Templated brand posts on abstract topics sit at the bottom. Evidence: pills/badges: 12.5% of best vs 22.2% of weakest (lift 0.59). Arrows/lines: 5.6% vs 9.7%. Text-only plates: 5.6% vs 13.9% (lift 0.45). XO's weak posts W2/W3/W4/W6 are fully on-template at x0.56-0.78. Tokeniza's black template cards run x0.38-0.62. None of Hurst's 13 on-brand carousels reached outlier status.
- [high] (format) Hard-sell and offer posts are the floor of every account. An offer only works when it rides a hook. Evidence: 5 of Nath's 6 worst are one masterclass funnel (x0.04-0.1). All 6 of Cerbasi's worst are sales or partner assets. Thiago's 50%-off post is x0.03. All 6 of GCB's worst are its own product marketing. XO's offer carousels (Union National #5/#6/#7, 3 ofertas, Medsystems #2) all sit at x1.0 or below. XO's vodka giveaway reached x12.11 only because it was told through the capybara.
- [medium] (layout) Best carousels close on substance (the biggest number, a document, the CTA with the disclaimer) and never on a recap of the cover. Evidence: InfoMoney's multi-slide outliers close on dense spec or document plates (x8.81, x16.46). INCO x3.42 closes on its two biggest numbers plus the disclaimer. Nath closes on save/share with a small plug. XO x2.33 closes on 'Abra sua conta pelo WhatsApp.' plus the risk line. None of the 13 best carousels whose interiors were read closes by repeating its cover.
- [medium] (other) Long captions that extend the cover's single idea, and save/share CTAs on reference content, both over-index. Evidence: caption_length long (>600 chars): 50% of best vs 36.1% of weakest (lift 1.37). Save/share CTA: 8.3% vs 1.4% (lift 3.5). Cerbasi's best all carry 625-994-character captions ending in a save/share ask, and Nath's law explainers end on 'Gostou do conteúdo? salve e compartilhe'. On Marília's account caption length alone doesn't separate best from worst.
- [low] (design) Visible logo lockups skew toward weak, templated posts. The mark should be a small, consistent signature and never a sticker or a hero. Evidence: logo_position top-left: 4.2% of best vs 9.7% of weakest. Bottom-left: 8.3% vs 15.3%. Centre: 1.4% vs 4.2%. Many winners carry no mark at all (9 of GCB's 12 tagged covers; 0 of Me Poupe's 12). XO's own system keeps its mark at ≈6% of width, top-left, plus a tiny footer mark.
- [medium] (hook) Timely news and before/after comparisons lift posts, and regulator news works for platforms. A CVM limit change framed around 'seu limite' is the right kind of topic for XO: our post failed on execution, and the topic was sound. Evidence: hook_type news/announcement: 23.6% of best vs 18.1% (lift 1.29). Comparison: 9.7% vs 6.9% (lift 1.33). Thiago's five best reels are all news-jacks (x9.3-x38.8). Tokeniza's CVM working-group card x2.0. Marília's Selic/prefixados post x2.63. Nath's law explainers x26.75-x31.5.

**Our post against these patterns**

- A CVM proposal is presented as a rule already in force, which is a compliance risk for a CVM-authorised platform. → Put an outlined mono status badge in XO's badge style ('PROPOSTA DA CVM · AINDA NÃO ESTÁ EM VIGOR') on every slide that mentions the change. Add one 'Mas atenção.' slide stating today's rule: R$ 20 mil per year, summed across all platforms. Base the CTA only on the current limit. Add a hard gate that blocks any regulatory claim unless its status (proposal or in force) and date are sourced.
- The regulator's logo is used as decoration, with a stray licence credit on the slide. → Never use regulator, government or partner marks as decoration. Name the CVM in text and use XO's outlined mono badge. Keep licence strings in the first comment, not on slides.
- The fonts are not the client's. → Set XO display type to Plus Jakarta Sans ExtraBold (800, about -2% tracking) and body to the same family in Regular (or Inter). Use one monospace only for eyebrows, badges, step numbers and footers. Remove Space Grotesk and the serif fallback from the kit, and confirm the font files with the client.
- The palette does not match XO's. → Tokens: background navy #0b2644, surface cream ≈#f3ecdc, gold accent (#e4cb9f on navy, #8b6b24 on cream). Peach #e6a47c is reserved for a single 'condição' pill. Alternate navy and cream slide by slide, and purge #050520, #06cf9c and #0095f6 from the XO kit.
- Text sizes swing from huge to tiny, with too many sizes per slide. → Allow three sizes per slide: headline at most 2 lines (≈5.5% interior, ≈8% cover), body ≈2.6% at no more than 3 lines, and a mono label at ≈1.8% as the floor, with nothing smaller. Use one hero number per carousel, set in gold with its unit inline.
- The language reads as AI-written and open-ended. → Write every headline as subject, verb and a concrete object, number or date, in 8 words or fewer, ending with a period. Examples: 'Hoje: R$ 20 mil por ano, / somando todas as plataformas.' and 'Proposta da CVM: / R$ 20 mil em cada plataforma.' Ban 'não X, (mas) Y' contrasts and aphorisms, and ban metaphors such as 'teto' or 'espaço' unless the number sits beside them. Run a pt-BR de-slop pass.
- Slides repeat themselves, so 8 slides carry about 4 facts. → Use 5-6 slides, each with a fact no other slide has, and dedupe on facts and numbers rather than wording. Suggested spine, on navy and cream alternately: 1) the 'Seu limite em crowdfunding / pode mudar.' cover with the current rule in one line; 2) 'Como é hoje.' with one bar split across 3 platforms; 3) 'O que a CVM propõe.' with three R$ 20 mil bars and the status badge; 4) 'Mas atenção.' covering what hasn't changed; 5) any other change, only if the CVM document confirms it; 6) 'Abra sua conta pelo WhatsApp.' with XOdó, link na bio and the risk line.
- The photo cover carries too much text with no shade. → Limit the cover to 12 words (a headline plus at most one short line). Use the navy plate with arcs by default. If a photo is used, it must show the subject (a phone with the XOdó chat, the real CVM document) and get a navy gradient of at least 60% opacity over the lower ~45% where the text sits.
- The logo is the wrong treatment and in the wrong place. → Use the brand kit's light mark with no box on navy and the rounded navy badge on cream, top-left and aligned to the text column. Add the small footer mark bottom-right. Never use a white square.
- The boxes don't match XO's design language. → Build XO's templates from DdmQQ6JG6Rc and DcRYkUKI0sK and forbid gradient panels. Show a comparison as two stat pills side by side at body size, or as a bar graphic.
- The post leans on pictures and has no information graphics. → Draw the rule instead: for 'Hoje', one R$ 20 mil bar split across 3 platforms; for 'Proposta', three separate R$ 20 mil bars. Show any sourced growth figure as a 2-point gold line, and use XO-style icon pills. Drop scenery photos. If the post needs a picture, use the client's own capybara once, as a small reaction on the cover or closer.
- A registration number is used as a hero statistic, and several strings are broken. → Put registration IDs only in the compliance line: 'Autorizada pela CVM · Ato Declaratório nº 23.290/2025'. QA should fail any slide with empty brackets, an ellipsis truncation, an unlabelled number or a non-pt-BR string.
- A quote card adds no information, and its sourcing is unverified. → Drop the quote slide unless the primary source is linked in the first comment. Never generate likenesses of real people. Source regulatory facts to the CVM's own document, and cut any market figure that can't be linked.
- The closing slide has no CTA and no risk disclaimer. → Make the closer a two-tone CTA headline, one XOdó line, a mono 'link na bio' and a ≈1.6-1.8% risk line. End the caption with the registration line and the standard disclaimer.
- Root cause: the run never saw XO's feed and rendered from a contaminated brand kit. → Record the feed-ingestion consent, or have staff upload 6-10 XO slides as references. Rerun the template studio seeded with DdmQQ6JG6Rc, and reconcile the kit to the tokens above. This fixes the fonts, colours, logo and containers at the source for every future XO post.

**Client rules (L3)**

- Colour: alternate navy #0b2644 (measured in the feed ≈#072443) and warm cream ≈#f3ecdc slide by slide. Gold is the only accent: ≈#e4cb9f on navy, ≈#8b6b24 on cream, #c9a861 in the logo ring. Peach #e6a47c is reserved for a single 'condição' pill. Never use near-black #050520, mint or teal, WhatsApp green outside a phone mockup, or Instagram blue.
- Type: one geometric family, Plus Jakarta Sans. Headlines in ExtraBold with tight (≈-2%) tracking, body in Regular, plus one monospace used only for eyebrows, footers, step numbers and badges. No Space Grotesk and no serif (the serif Buffett cover sits at x0.78).
- Headline: at most 2 lines and 3-8 words, a complete statement ending in a period or one precise question. Split it two-tone at the line break: line 1 white on navy or navy on cream, line 2 gold.
- Exactly three text sizes per slide: headline ≈5.5% of slide height per line (≈8% on the cover); body ≈2.6%, at most 3 lines and 25 words; mono label ≈1.8% as the floor, with nothing smaller. Use one hero number per carousel, in gold with its unit inline at body size ('22% ao ano').
- Frame: the XO mark sits top-left on the text margin, as the light mark directly on navy or the navy rounded-square badge on cream. Hairline rules go under the header and above the footer. The footer carries a mono section eyebrow bottom-left (AMBIENTE REGULADO, ESTRUTURA DE GARANTIAS…) and a small XO bottom-right; the cover footer adds 'ARRASTE →'. Never a white box, never top-right.
- Allowed devices only: 01/02/03 rows with a thin gold rule, outlined mono badges for regulation codes, white stat pills with a round navy/gold icon plus value plus label, a WhatsApp phone mockup with the XOdó bot, and faint concentric arcs on navy. No gradient panels, and no regulator or partner logos used as decoration.
- Cover: 12 words or fewer, on the navy plate by default. Answer the cover's question or complete its fact on the cover itself, following 'O que é a XO Digital?' with its one-line answer. If a photo is used, it gets a navy gradient scrim of at least 60% over the lower ~45%.
- Carousel spine (from DdmQQ6JG6Rc): hook, how it works (01/02/03), CVM trust beat (badges), guarantees, proof in the product (WhatsApp mockup), then the CTA 'Abra sua conta pelo WhatsApp.' with the XOdó line, 'link na bio' and the risk line. Run 5-7 slides; every slide adds a new fact, and there is no recap slide.
- Compliance on every post: the caption ends with the CVM authorisation (Resolução 88/2022, Ato Declaratório nº 23.290/2025) and 'Investimentos envolvem riscos. Rentabilidade passada não garante resultados futuros. Leia as informações essenciais de cada oferta antes de investir.' The closer carries the risk line in small print. Returns are always 'até X% a.a.', and past returns are labelled as past. A regulatory proposal is labelled 'proposta, ainda não vale' on every slide that mentions it. Registration numbers never appear as statistics.
- Mascot: the capybara (client-owned renders, not regenerated) is XO's reach device. Use it in reels and single-image memes with a meme line of 8 words or fewer and the pitch in the caption. In a carousel use it once at most, as a small cut-out on the cover or closer. No other AI imagery: no skylines, suited men, holograms or handshakes (W1 sits at x0.44).
- Offers: lead with the benefit and the number, never the product code name, and put one offer per post. On Union National #6 the real hook was hidden in a pill ('A XO paga o seu imposto de renda'); that line should have been the headline. The 3-offer cover sat at x0.56.
- Run proof formats every month. The first is a '[Mês] na XO' report: navy cover, one gold line chart and one headline number, following INCO's DdRZzrKIG2q. The second is 'A XO na mídia' whenever a third party covers XO: phone mockup plus 3 stat pills. Use XO's real figures (R$ 6,5 mi distribuídos, +100 investidores, 157% do CDI average on settled operations, Medsystems #1 settled 7 days early), each with its date.
- Voice: pt-BR, addressed to 'você', with concrete verbs. Light wit is allowed in reel and meme captions (POV, capivara). No English words on slides, no 'não X, (mas) Y' contrasts, no aphorisms.
- Topics: regulator or rule-change news about the reader's own limit, tax or return is a good XO topic. Structure it as 'Hoje / Proposta / Mas atenção / O que fazer agora' and draw it as bars. Market-size stories are not a hook: comparable cards sit at x0.62-0.78.

**Industry rules (L2)**

- The cover states the reader's stake in one checkable sentence of 12 words or fewer: a rule with its effective date, a product with its rate and minimum, or a named person with a number. It is never an abstract concept, a listicle count ('3 ativos…') or a market-size figure.
- Borrow authority through the subject: regulators, exchanges, press, events and named guests carry posts (other-brand presence is 15.3% of best vs 2.8% of weakest). Name them in text; never paste a regulator's mark as decoration.
- Rule-change explainers put the status (proposal or in force) and the date on the cover. The slides then follow 'o que muda', 'quem ganha e o que continua igual', 'mas atenção', 'o que fazer'. The pitch comes last and small, and the post closes with save/share.
- One layout per carousel: fixed headline position, headlines of at most 2 lines, one body block and one pacing device. Change the content, not the structure.
- At most three text sizes per slide (4+ sizes appear on 30.6% of weakest vs 13.9% of best). Headlines are never small (12.5% of weakest vs 4.2% of best), and headlines use a heavy display weight.
- One new fact per slide. Carousels close on substance (the biggest number, the document, or the CTA with the disclaimer) and never on a recap of the cover.
- Text over a photo always sits on a scrim, and the photo shows the actual subject: the product, the person, the document. No stock or generic AI finance scenery (stock-looking photos are on 11.1% of weakest vs 2.8% of best).
- Turn numbers into graphics (charts, before/after bars, stat pills with icons, ranked logo lists) instead of describing them in paragraphs. Data graphics show lift 3 and icons lift 2.7.
- State the uncomfortable number before the reassuring one: late payments before the on-time %, a veto before the new right. The top explainer posts of both INCO and Nath do this.
- A sales pitch needs a hook or it doesn't run. Never repeat one offer template several times in a week: own-product pitches fill Nath's 5 worst of 6, and all 6 worst for Cerbasi and GCB.
- Headlines are complete, conversational sentences (conversational 30.6% vs 19.4%; hype 6.9% vs 13.9%). No fragments, no hype adjectives, no 'não X, mas Y' filler.
- Disclose every time: a risk line in the caption and small print on the closer. Registration and licence numbers appear only in compliance lines, and a proposal is never presented as in force.
- Reels need a real person on camera or an owned character, plus one concrete fact. For mid-size platforms, carousels are for proof reports and explainers rather than reach (Hurst's 13 carousels produced 0 outliers). Long captions (>600 chars: 50% of best vs 36.1% of weakest) are fine when they extend the cover's single idea.

## Client synthesis: sitti

**Best creators**

- @stanforcreators: The strongest proof in the set that a creator selling their own travel knowledge makes a story people share, and that is exactly Sitti's promise. B1 (ER nurse Nina's $45 Japan guide, '$85,235 in two weeks', 23.0x, 746 comments) and its sequel B3 (17.0x) put one real, named person and one real number on the cover, run a fixed beat structure (setup, turn, product card, emotional quote, proof, 'Comment NINA'), use two type families and one accent colour, and keep a scrim under every line of photo text. The same idea told as generic advice (W2, 0.23x) failed.
- @wherethefuckdowego: The Corner app is the nearest product analog: people save spots to a map. It posts near-daily carousels on one fixed skeleton: a white card on a real candid photo, one venue per slide with a neighbourhood tag, and the app's own place card (save count, TRENDING pill, saved-by avatars) inset as social proof. It closes on a fixed CTA. Its best post (B1, 4.97x) is a named duo's list that ends on their real app profiles. W1 is also a named user feature and scored 0.29x, so what separates them is a concrete promise ('prove you can still meet people irl', 'the dj actually reads the room'), not the format.
- @mindtrip.ai: B1 'Where You Should Travel Based on Your Hobby' (29.7x, 9 slides) is the largest carousel outlier measured against a clean baseline. It uses an 8-word personalisation cover, one hobby-to-city pair per slide, a darkened band plus a white rounded card so text never sits raw on a photo, and a dark-pill Follow closer. All five winning carousels use one of only two templates. Its worst covers are a 10-item list on one frame (0.17x) and selfie talking heads.
- @letsdiscoverapp: The most direct competitor to Sitti's creator pitch, at the same tiny scale (519 followers). Founder-POV reels about one specific find beat everything else: a Thames shipwreck with 'Want the locations of every place I go to?' got 7,549 views (10.5x), and a 500-year-old rosary bead got 3.9x. Its 'monetise your recommendations' carousels are its worst posts: 'Your followers want to go to your recommendations' 0.15x and 'You're leaving thousands on the table.' 0.23x. Our post belongs to that losing genre.
- @sitti.app: The house style to extend, not replace. Founder storytime reels with huge stacked coral/yellow text over a candid frame are the account's reach engine: B1 'how did I end up here' 2.75x with 8,620 views (14x followers), B2 1.88x with 13 comments. The Gaegu creator-map carousel (B3 'matt peterson / nyc no line recs', 1.05x) defines the client's real fonts, colours, pins, arrow, lockup and CTA closer.
- @spottedbylocals: Its graphic grammar is the closest to Sitti's hand-drawn look: a pin icon plus a hand-lettered, colour-rotating place name, and traced outlines around the building, all on real photos. It closes on a fixed localized sign-off card. Its comment-to-vote giveaway drew 111 comments. Caveat: 28 of 36 posts hide likes, so its 20-69x multiples compare real likes to a placeholder. Only comments are a fair signal (median 11.5 on visible-like posts vs 1.0 on hidden ones).
- @infatuation: B3 'Which Tasting Menus Are Worth It?' (8.2x, 470 comments) is a pure quadrant chart with no photography. It proves an opinionated graphic with real names and prices can outdraw photo posts, which is the direct answer to 'too AI-picture heavy, not enough graphics'. Caveat: all six of its 'worst' posts hide likes, so judge them by views (11.7K-23.7K against a 63.5K median).

**Best content**

- @sitti.app https://www.instagram.com/p/DdZRmg0OJZf/: The client's own best post (2.75x, 109 likes, 16 comments, 8,620 views on 615 followers). It opens a story loop in 5 huge stacked lowercase words ('how did I end up here') in coral over a raw top-down founder frame. Real person, no polish, no logo. This is the voice and reach engine that reels should keep.
- @sitti.app https://www.instagram.com/p/DcZbm9WjnXS/: The client's real carousel system (1.05x, 7 slides). The cream cover has 'matt peterson' in coral Gaegu, 'nyc no line recs' in black, a yellow dashed arrow pointing right as a swipe cue, the creator's real photo in a rounded frame, and the icon-row + 'mapped by sitti' lockup bottom-right. Five interiors each show one real spot under a coral top-gradient shade, with a yellow pun title ('the no-queue cafecito', 'clobster, no clamour'), a pin + venue name, and a bare citrus slice top-right. The closer is a cream-to-coral card: 'see the full no-line recs map linked in bio'. That's 2 text sizes and 4-8 words per slide.
- @stanforcreators https://www.instagram.com/p/DcRz-56Elmd/: The model for any 'creators can sell their recs' message (23.0x, 9,235 likes, 746 comments). A real named creator sold a $45 Japan travel guide. The cover leads with the number ('$85,235 in two weeks.'), each beat has a scrim, slide 6 shows the actual storefront product card as proof, and the CTA names the person ('Comment NINA'). If Sitti tells an earnings story, it has to look like this, with real numbers.
- @wherethefuckdowego https://www.instagram.com/p/Dbv3ZsfDA0m/: 4.97x (5,088 likes). A named duo's list ('a london lad's guide to third spaces that prove you can still meet people irl') on a white card over a real photo with their Polaroid insets. Each venue slide has 'what it is:' and 'why you should go:', and the closer mocks their real app profiles and saved lists: 'join thomas, jacob, and 250K+ others'. For Sitti, the closer should be the featured creator's real map card in the app.
- @wherethefuckdowego https://www.instagram.com/p/Dc1Bk_2DH5e/: 4.45x. A specific insider promise ('a responsible guide to blacking out', 'IN NYC' badge) with the words on a white card rather than raw on the photo. Six slides repeat the same skeleton: venue label, neighbourhood tag, one 'the vibes:' line, and a small live app place card as social proof. It ends on the fixed 'get the full list on the corner app' card.
- @mindtrip.ai https://www.instagram.com/p/Dc1cEO_mD6s/: 29.7x (2,215 likes). The cover is a personalisation hook in 8 words with one italic accent word. Each interior pairs one hobby with one city ('Cooking: Bologna') and a ~20-word white card, set on a darkened band so text never sits raw on the photo. The layout never changes, and the closer is a dark 'Follow' pill.
- @letsdiscoverapp https://www.instagram.com/p/DZKLWaTh4NQ/: 10.5x, 7,549 views on 519 followers. One specific founder find (a shipwreck on the Thames foreshore) with one short line in a black box ('Want the locations of every place I go to?') and a 'comment MAP' CTA. Same competitor, same audience: its creator-pitch carousels scored 0.15-0.23x (e.g. https://www.instagram.com/p/DX9dhaOiD4d/).
- @spottedbylocals https://www.instagram.com/p/DYmdc_Jjejf/: A 10-slide Prague guide (178 likes, 17 comments, likes visible). The cover promises a specific route ('Tramline 23 Prague'). Every spot slide has a pin + hand-lettered place name in a rotating colour and a traced outline around the building on a real photo, with 9-18 words of fact. It closes on a localized sign-off card with cut-out photos of that city's locals. The hand-drawn-over-real-photo grammar fits Sitti's Gaegu look.
- @infatuation https://www.instagram.com/p/Dbq-EPzlKxk/: 8.2x, 470 comments on 9,023 likes. No photos at all: an opinionated quadrant chart of 13 named restaurants with real prices. The same 3-line headline repeats on each slide, and each interior zooms into one quadrant. The graphic is the content. Sitti's equivalent is a real map with real pins.
- @beli_eats https://www.instagram.com/p/DcUo2dZBKUr/: 2.3x, 1.41M views, 423 comments. A ranked list with a one-word tall headline, a data-credibility line ('based on over 120 million ratings on Beli') and a specific comment prompt ('Let us know what you think should have made the list'). It shows how a list post turns into conversation.

**Patterns**

- [high] (hook) The winners lead with a specific person or place plus one concrete promise. Abstract advice and product pitches sink. Evidence: Stan B1 'ER nurse, $85,235 in two weeks' 23.0x and B3 17.0x vs Stan W2 generic selling advice 0.23x. letsdiscoverapp founder-find reels B1 10.5x (7,549 views on 519 followers), B4 3.9x, B5 3.0x vs its creator-pitch carousels W1 0.15x, W3 0.23x. Corner B2 'a responsible guide to blacking out IN NYC' 4.45x. Pooled: story/narrative hook 23.9% of best vs 4.5% of weakest (lift 4.19); product promo/offer 1.4% vs 12.1% (0.21); hype/promotional register 5.6% vs 24.2% (0.27).
- [medium] (format) Carousels pitching creators to monetise their recommendations are the weakest format among direct competitors, and our post is one of them. The idea only worked when told through one named creator with real numbers. Evidence: letsdiscoverapp W1 'FOR CREATORS / Your followers want to go to your recommendations' 0.15x (2 likes), W3 'TRUTH BOMB / You're leaving thousands on the table.' 0.23x (3 likes), W2 0.15x. All were 3-4 months old at scrape, so recency doesn't explain them. Sitti's own pinned 'Make your first map' carousel sat at 0.40x after 9 days, its weakest aged post. Stan's advice carousel W2 scored 0.23x, while Stan B1 (a real creator's $45 Japan guide) scored 23.0x.
- [high] (design) In every winning system, text on a photo sits on a legibility device. Sitti's own covers keep text off the photo entirely. Evidence: Corner: a white card on every cover and slide. mindtrip B1 (29.7x): darkened top band plus a white rounded card. Stan B1: dark gradient scrim under '$85,235 in two weeks.' Sitti interiors: coral/pink top gradient behind a 5-7 word yellow title. Sitti covers: title on cream, photo in a rounded frame below. Our cover puts 20 words over the photo with a light cream fade that starts mid-frame, so the headline's first line sits on the subject's shoulder. The one exception is Sitti's reels, which set 4-5 huge high-contrast words directly on the frame.
- [medium] (font sizes) Winners use few words and one dominant type size. Many sizes and paragraph covers go with the weakest posts. Evidence: Pooled cover words: median 6 on best vs 10 on weakest. 4+ text sizes: 5.6% of best vs 12.1% of weakest (0.52). 'Huge' headline: 18.3% vs 1.5% (6.52), but it is one short line (Stan's 4-word '$85,235 in two weeks.', mindtrip's 8-word stacked cover). mindtrip's 10-item list cover scored 0.17x. Sitti's carousels use 4-5 cover words, 5-7 per interior and 2 sizes at about 1.5-2:1. Our deck has 20-52 words per slide and 9 distinct sizes (220/124/84/46/34/32/26/25/22 px on 1080), 6 of them on the 'versus' slide (scratchpad/type-audit.json).
- [high] (design) Sitti's real type and colour system is Gaegu with coral and yellow on cream. The brand kit our agent rendered from is wrong at the source. Evidence: The sitti.app root <html> carries only the Gaegu font variable (/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/sitehtml/www_sitti_app_.html). Site colours: #8A3B42 (50 uses, the site's body ink), #FFF8D6 cream, #FF5B5F coral (theme-color), #FFD86A yellow, #FFF2BF. Both sampled carousels set every title and tag in lowercase Gaegu: coral titles on cream, yellow titles on photos, a black cover subtitle, and maroon only inside the tiny 'mapped by sitti' lockup. Our run's kit was Space Grotesk + Inter with IBM Plex Mono labels and maroon headlines. Correction: the per-account summary's 'chunky display-sans, no script' describes the reels, not the carousels.
- [high] (graphics) Sitti's logo and graphic grammar varies by slide type, and our render matched none of it. Evidence: From the slide files. Cover: yellow dashed curved arrow top-right pointing right (a swipe cue), real photo in a rounded frame, lockup bottom-right (four line icons for compass, waves, flag and sunrise, the citrus slice, and 'mapped by sitti'). Interiors: pin icon + venue name under the title, bare citrus slice top-right, no lockup. Closer: cream-to-coral gradient with the lockup centred. The per-account summary's 'bottom-left lockup on every slide' and 'arrow pointing down' are wrong. Our deck put the square app-icon tile (drop shadow, a visible square halo on the photo cover) top-right on all 8 slides, plus a monospace '@sitti.app' bottom-left on all 8.
- [medium] (graphics) The winners use the product itself as the graphic layer (app cards, save counts, storefront cards, charts) instead of decorative boxes or stock people. Evidence: Corner: a live app place card (save count, TRENDING/POPULAR pill, saved-by avatars, age chart) inset on every interior; B1's closer mocks the duo's real app profiles (4.97x). Stan B1 slide 6: the storefront product card ($45, 5.0 stars, Get it now). mapstr: per-slide save counts. infatuation B3: a pure quadrant chart with 470 comments and no photos. Our graphics are a coral rule, peach gradient panels and mono numbering. No map, pin, route or app screen appears.
- [medium] (imagery) The winners use real photos of the actual place or person. Generic stock or AI-looking people never appear in a best post. Evidence: The per-account reads found only real, candid photography in the best posts at Corner, mindtrip, mapstr, spottedbylocals, rexby, prettycitylondon, yallabikes, beli and Stan. Stock appears only in secret_nyc weather/season posts ('Pictures: Pexels'). Sitti's photos are the featured creator and the actual venues and dishes. Our S1 (a bearded man in a studio) and S2 (a young man writing in a café) show no creator, city or venue.
- [medium] (format) Below 1K followers, founder story and discovery reels are where reach comes from. Carousels carry the repeatable series. Evidence: Sitti B1 reel: 8,620 views (14x followers), 2.75x. B2 reel: 2,294 views, 1.88x. Carousels B3/B4: 1.05x/0.95x. letsdiscoverapp: founder reels at 7.5K-14.3K views on 519 followers; 5 of its 6 worst posts are carousels.
- [medium] (layout) Winning accounts run one fixed skeleton per series, one place per slide and a fixed closer. They vary the topic, not the layout. Evidence: Corner B2/B3/B4 are identical end to end (venue label + neighbourhood tag + 'the vibes:' + app card, same 'REAL REVIEWS FROM REAL PEOPLE' closer). Two mindtrip templates carry all five of its best carousels. spottedbylocals and mapstr use identical per-city skeletons. Sitti B3 runs cover, 5 spots, CTA closer. Our 8 slides use 6 layouts (photo cover, photo band, stat box, numbered list, versus columns, boxed split closer) and repeat themselves.
- [medium] (language) The feature format is not what wins. The promise is: winners name a concrete need, losers use an aesthetic label. Evidence: Corner B1 (named London duo, 'third spaces that prove you can still meet people irl', 4.97x) and W1 (named Berlin user, 'good food / sexy interiors', 0.29x) share the same user-feature collage template. Corner's other winners promise a need ('the dj actually reads the room', 'dance that's not berghain'). Sitti's no-line pun series (B3 1.05x) edged its flat labels ('brunch time', B4 0.95x), though that is n=2.
- [medium] (language) On-slide copy in the winners names concrete things. Ours names only abstractions. Evidence: Winners: Corner venue + neighbourhood labels; mindtrip 'Cooking: Bologna'; spottedbylocals pin + place name; Sitti 'the no-queue cafecito / rossa café', 'clobster, no clamour / the crabby shack'; Stan's numbers always belong to Nina. Ours across 8 slides: 'matrix', 'criteria', 'platform', 'metric', 'baseline', 'pilot', 'the standard', with vague referents ('There's a scoring matrix for this.', 'Earning follows from those two.') and not one named place or person.
- [medium] (hook) Comment prompts help, but the scoring formula exaggerates their effect. Evidence: Pooled comment-prompt CTA: 25.4% of best vs 7.6% of weakest (2.95); link-in-bio: 9.9% vs 21.2% (0.5). But engagement = likes + 3x comments, and several winners are comment-keyword funnels (Stan 'Comment NINA' 746 comments; spottedbylocals giveaway 111; beli 'let us know what should have made the list' 423). At Sitti, B2's 'which spots do you want a sitti review of??' drew 13 comments; B3, with no prompt, drew 0.
- [high] (other) Nearly half of the pooled 'weakest' set is measurement artefact. Any lift driven by those posts should be treated as low confidence. Evidence: 20 of the 66 weakest posts have hidden likes (the API returns a placeholder of 3): all six worst at mapstr, spottedbylocals and infatuation, plus secret_nyc W1 and prettycitylondon W1. Another 10 were under 25h old at scrape: secret_nyc W2 0h, W4 2h, W6 3h; Corner W6 4h; mindtrip W6 2h; yallabikes W5 5h; beli W3 24h; rexby W1/W5/W6. Sitti's B5 (0.42x) was 3.7h old, so the 'missing headline' reading is not evidence. The pooled n of 71/66 against 77/72 expected means one account's tags are missing. Fair comparisons: spottedbylocals visible-like posts get a median 11.5 comments vs 1.0 on hidden ones; infatuation W1-W5 got 11.7K-23.7K views against a 63.5K median reel, so weak (~0.2-0.4x) but not ~0.01x. Lifts on list hooks, share CTAs, top-left logos, dark photos and pills lean on those posts.

**Our post against these patterns**

- Wrong topic: the post applies a software feature-adoption framework to creators instead of showing a city, a creator or a map. → For Sitti, choose topics only from (a) a named creator's map of a named city with one concrete promise ('nyc no line recs'), or (b) a founder story. Turn hot-news mode off unless the news is a specific place or event in a city the client covers.
- The numbers contradict each other, which is the 'something doesn't make sense' problem. → Add a fact gate before render. Every figure maps to one source row, parts must reconcile to their stated total, and a renamed term or a headline that contradicts another headline fails the run.
- The rendered deck doesn't match the copy spec, and slides repeat. → Gate on rendered slide count and per-slide text matching the spec. Reject duplicate images, repeated headline stems and repeated stats. Clear stale slide objects before a re-render. Each slide must add one new spot or beat.
- Truncated and orphan content inside boxes. → Fail the render on any ellipsis, overflow or unlabeled number. For Sitti, drop stat panels entirely.
- The fonts are not the client's. → Set Sitti's kit to Gaegu only: lowercase, no terminal periods. Fix the kit extraction that recorded Space Grotesk/Inter for a Gaegu site.
- Text sizes swing between huge and tiny. → Allow at most 2 text sizes per slide (title + tag) plus the lockup. The title is no more than 2x the tag, nothing goes under ~36px at 1080 wide, and there are no hero numerals.
- Wrong colour roles. → Use coral #FF5B5F for titles on cream #FFF8D6, yellow #FFD86A for titles on photos, black for the cover subtitle, maroon for the lockup only. The closer is a cream-to-coral vertical gradient.
- The boxes don't belong to the client's design language. → Disable the stat-callout, list-takeaway, versus and boxed split-closer devices for Sitti. Allowed devices: pin + venue tag, rounded photo frame, yellow dashed arrow, gradient closer.
- The logo is badly sized and placed. → Add a transparent-background slice and the lockup to the brand kit as files. Place them by slide type, about 8% of slide width for the slice. Remove the tile and the handle.
- The photo cover carries too much text without a shade. → Put the cover title and subtitle on cream above a rounded-frame photo. Only interiors carry text on a photo: 7 words or fewer, inside the top gradient.
- Stock/AI-looking people and no graphics. → Use only photos of the featured creator and the actual spots, supplied by the creator or owned by the client. Build graphics from the product: pins, a dashed route, and a real in-app map card (title, @creator, pin count, price) with real values only.
- The copy is abstract and reads like AI. → Write in lowercase, and make every line name a spot, dish, person or city. Pun on the series promise. Ban matrix, criteria, framework, platform, metric, baseline, pilot, 'the standard' and 'built to', and don't end slides on aphorisms.
- Too text-heavy. → Keep the cover to 6 words or fewer and interiors to 8 or fewer. Move details and venue @handles into the caption.
- The CTA is buried. → Use a dedicated cream-to-coral closer with one line naming the map plus 'linked in bio'. Add one specific comment prompt to the caption ('tag whose map you want next', 'which spots do you want a sitti review of??').

**Client rules (L3)**

- Topic: every carousel is one named creator's (or the founder's) map of one named city, with one concrete promise in the subtitle (e.g. 'nyc no line recs'). Never creator-economy theory, platform frameworks, or hot-news topics that aren't about a specific place.
- Type: Gaegu only, for all slide text, all lowercase, no terminal periods. No Space Grotesk, Inter or IBM Plex Mono. The 'mapped by sitti' lockup is placed as a kit image file, never typeset.
- Colour: coral #FF5B5F titles on cream #FFF8D6; yellow #FFD86A titles on photos; black for the cover subtitle; maroon #8A3B42 only inside the lockup. The closer is a cream-to-coral vertical gradient. No peach panels or other fills.
- Sizes: at most 2 text sizes per slide (title + tag) plus the lockup. The title is about 1.5-2x the tag. Nothing under ~36px on a 1080-wide canvas. No hero stat numerals.
- Cover: cream ground, a coral creator/city title of 3 words or fewer, a black subtitle of 4 words or fewer, a yellow dashed curved arrow top-right pointing right, one real photo of the creator in a rounded-corner frame below, and the lockup bottom-right. No text on the photo.
- Interior: one spot per slide, on a full-bleed real photo of that spot or dish. Coral/pink top-gradient shade; yellow pun title top-left (6 words or fewer); pin icon + venue name (3 words or fewer) beneath it; bare citrus slice top-right. Nothing else: no boxes, rules, numbers, handles or lockup.
- Closer: a dedicated cream-to-coral card with one coral line, 'see the full [promise] map linked in bio', and the lockup centred at the bottom.
- Logo: never the square app-icon tile or a drop-shadowed badge, and never '@sitti.app' on a slide. Put the bare slice (~8% of width) on interiors only, and the lockup on the cover (bottom-right) and closer (bottom-centre) only.
- Imagery: only real photos of the featured creator and the actual venues, supplied by the creator or owned by the client, never lifted from third-party accounts without permission. Zero AI or stock people. If real photos don't exist, don't make the post.
- Graphics come from the product: pins, dashed route lines, and a real in-app map card (title, @creator, pin count, price) with real values. Never invent pin counts, prices, unlock numbers or earnings. The client is pre-traction.
- Copy: every line names a spot, dish, person or city, and puns on the series promise ('the no-queue cafecito', 'clobster, no clamour'). Banned: matrix, criteria, framework, platform, metric, baseline, pilot, 'the standard', 'built to', and dangling 'this/those' referents.
- Integrity: 6-8 slides, made of a cover, 4-6 spots and a closer. No repeated headline stems, spots or stats. Every number traces to a source and reconciles. No truncation or ellipses. Rendered slides must equal the spec.
- Caption: 1-2 short lines in the client's voice (lowercase, '!!'/'??' allowed): '[creator] [city] [promise] map linked in bio'. @-tag each venue on its own line, add one comment prompt ('tag whose map you want next'), and use 1-3 hashtags including #sitti.
- Earnings or 'creators can sell' messages need a real named creator with verifiable numbers, told as a story (Stan-style beats). Until Sitti has one, use the founder's build-in-public story, never a pitch carousel.
- Founder storytime belongs in reels, the account's reach engine (8,620 views = 14x followers): 5 or fewer huge stacked coral/yellow words that open a loop over a candid founder frame. Never turn those stories into text carousels.

**Industry rules (L2)**

- Lead every post with a named place, person or city plus one concrete promise ('no line', 'meet people irl', 'the dj actually reads the room'). Never an abstract framework, a generic 'best of', or platform theory.
- Sell the app through someone's list or story, never a pitch. 'Monetise your recommendations' carousels are the category's weakest format (0.15-0.23x at letsdiscoverapp), and earnings stories only work with a real named creator and real numbers (Stan, 23x).
- One place per interior slide, named, with a neighbourhood or city tag. Keep one skeleton per series and vary the topic, not the layout.
- Use real photos of the actual place or person. No AI-looking or generic stock people; stock is only acceptable for weather or season news.
- Never set text raw on a busy photo: use a solid card, a darkened band or a gradient shade, and keep on-photo text to ~8 words. The only exception is a line of 5 words or fewer at huge size in high contrast on a reel cover.
- Cover: one idea in 8 words or fewer (winners' median is 6, against 10 for the weakest posts). No lists or paragraphs on the cover.
- Type: 1-2 families, no more than 3 sizes per slide with one dominant line, and no micro text (under ~32px at 1080 wide).
- Make the product the graphic: a real app card, save or unlock count, map, route or storefront card as proof inside the carousel, not decorative boxes or stat panels.
- End on one fixed CTA slide tied to the list (the full list or map in the app, or link in bio), and ask one specific question in the caption.
- Local and timely beats generic. Season, weather and event pegs and the home-city rotation outperform one-off cities and far-away destinations (medium confidence).
- For small accounts, founder-POV discovery and story reels bring the reach. Carousels carry the repeatable series.
- Measure cleanly: drop posts with hidden likes (the likes=3 placeholder) and posts under 72h old from best/worst rankings, compare reels on views, and discount comment-keyword funnels when scoring likes + 3x comments.

## Client synthesis: geektime

**Best creators**

- @geektimecoil: The client's own posts are the strongest content in the whole set relative to baseline. Its product-in-hand price and availability posts hit 26.5x (B1, 595 likes, 49 comments), 16.11x (B2) and 8.54x (B4), all on the house navy/lime/white template with Geektime's own photos. Its native one-offs show the audience also rewards geek humour with no design at all: a Doom-on-a-DSLR reel at 13.36x and a reader's ChatGPT-written fan manual at 7.61x. Clone these before borrowing anything external.
- @themarker_online: Best Hebrew business carousel craft in the set, with a median ER of 0.56% (2.3x Geektime's). Covers lead with a person's quote or a giant numeral. Interior slides are one-idea quote cards: one text size (2.3-2.6% of height) in a charcoal block under a new photo. A mint accent is kept for hooks only. The B1 bookstore-CEO interview hit 9.3x; the '100' numeral reel drew 98,716 views.
- @israel.business: Highest median ER in the set (1.73% on 168K followers). It makes money concrete: the figure goes in digits inside a two-line colour headline band, with a recognisable face and 'פרסום ראשון' ribbons on scoops. Its fuel-price post (2.64x) is the nearest analog to Geektime's iPhone-price winners. Two of its tagged 'worst' posts have hidden likes, so only its best posts are usable evidence.
- @visualcap: The concrete answer to 'not enough graphics': each image carries one extreme comparison readable in a second (US car colours 50.54x; workdays to buy an iPhone 17 Pro 5.72x). Its 26 organic charts run at a 1.89x median, while all 10 of its partner posts sit below median (0.43x). The iPhone-workdays chart is a ready-made Geektime format.
- @morningbrew: Shows how to make news carousels graphic without illustration. The cover is a photo plus a logo inset plus the headline. Interior slides are primary-source receipts: a giant pull-quote card, and the company's and the official's own statements screenshotted on cards in their brand colours. DoorDash hit 3.77x, Mbappe/Nike 3.79x, the Shopify memo 3.36x, all mature posts.
- @wired: Draws original data well. The 634-woman survey carousel (10.17x) alternates flat charts with verbatim quote cards, one solid colour per slide, two type sizes and a persistent watermark. Its biggest post (the ZuckOff app by a 30-year-old developer, 17.35x) is a named-maker story, the same mechanic as Geektime's best non-price posts.
- @evolving.ai: Covers an AI model launch the way Geektime should. 'Claude Opus 5.5 has only been out for 1 day...' (2.74x, 29,420 likes) is 17 slides of things people built, one short caption bar per slide over the demo itself, rather than a spec or price sheet. Captions stay short: 4 of 6 best posts are under 600 characters, while all 6 weakest are over.
- @calcalist: Clean Hebrew exclusivity device: a red 'בלעדי לכלכליסט' pill over a bold two-line black headline on a white card under a real photo (NVIDIA Israel research group, 3.56x). On the RealSense exit it led with the staff payout ('העובדים יהפכו למיליונרים') and reached 0.22% of followers, against TheMarker's 0.17% with the same team photo and a corporate framing.

**Best content**

- @geektimecoil https://www.instagram.com/p/DdoMDIWjTVx/: B1, 26.5x (595 likes, 49 comments, 33h old). Slide 1 is Geektime's own photo of the maroon iPhone 18 Pro in hand. It carries a 6-word white overline on the dark phone body, the navy wordmark tab, and a rounded lime/white card with a 7-word verb-led headline ('אושר עד' מרסקת את מחירי האייפון 18 פרו). Slide 2 is the retailer's own flyer, untouched, as the receipt (price, specs, the 10 branches). The caption gives the numbers (4,490 NIS, more than 500 below the importers) and the catches. This is the model for every price story.
- @geektimecoil https://www.instagram.com/p/DcQ7R6ytJNT/: B2, 16.11x. A single image on the same product-in-hand template. The headline states the consequence (Apple lowers iPhone prices in Israel) and the caption gives the figure (320 NIS, 270 in Eilat). It shows one frame is enough when the stake is clear.
- @geektimecoil https://www.instagram.com/p/DdBMx_nND-s/: B4, 8.54x. 'פרסום ראשון!' earned by a real scoop with a stake: Israel joins Apple's first launch wave, with pre-orders opening this Friday. Same template, with the card in the lower third.
- @geektimecoil https://www.instagram.com/p/DdlOGZGNHs6/: B6, 4.11x. The navy-plate template done right: wordmark top-right, a rounded card with a 9-word headline, and a real game screenshot below with a credit line. A named Israeli creator, 90s nostalgia, 'free' and 'built with AI': an AI story told through a person.
- @geektimecoil https://www.instagram.com/p/DcQlEFDCXmU/: B3, 13.36x, 7,614 views. Raw phone video of Doom running on a 16-year-old Canon DSLR, with zero design and a two-sentence wry caption. Native geek humour is a lane where the template isn't needed.
- @geektimecoil https://www.instagram.com/p/DcHMrfZCmUh/: B5, 7.61x. A reader's photographed fan-assembly manual with one hand-drawn circle, quoting his complaint that ChatGPT wrote it. A relatable AI fail from a named person, with no template.
- @themarker_online https://www.instagram.com/p/Ddd_86Qjr2K/: 9.3x (1,324 likes, 210 comments). The cover leads with the CEO's blunt quote over his portrait. Slides 2-7 each pair a new photo with one quote card on a new sub-topic (staff shortages, self-publishing costs, teen reading, cookbooks), one text size per slide. It closes on 'link in story'. This is the template for a Geektime interview.
- @themarker_online https://www.instagram.com/p/Ddlqia6u13-/: Paired with Ddn50gjuR1O: same series, host and format. Episode 1, with a giant mint '100 תחנות' numeral on the cover, drew 98,716 views (3.3x). Episode 2, with a small lower-third caption, drew 3,270 (0.35x). Both were over 36h old. The numeral is the visible difference; episode order is a confound.
- @calcalist https://www.instagram.com/p/DdnkQnvjOlJ/: 3.56x. A real photo of NVIDIA's Israel HQ, a red 'בלעדי לכלכליסט' pill, and a bold two-line headline on a white card. Slides 2-3 name the executives and the hospital partners in one plain paragraph each. A clean Hebrew exclusive format that closes on credibility.
- @israel.business https://www.instagram.com/p/Dc8gdjOO879/: 2.64x on the set's highest baseline (1.73% ER). A fuel price drop with the new price in digits ('7.75'), set in a second colour inside a two-line headline band. It's a price the reader pays, the same mechanic as Geektime's iPhone price posts.
- @visualcap https://www.instagram.com/p/Dc3jvZAjiwD/: 5.72x. 'Workdays to buy an iPhone 17 Pro' by country: a large headline, one ranked bar chart filling most of the frame, flags, a one-line takeaway and a source line. A direct template for a Geektime iPhone 18 Pro graphic using Israeli wages and prices.
- @morningbrew https://www.instagram.com/p/Ddm-P9XE_bT/: 3.77x. Cover photo, logo inset and headline, then a giant pull-quote card, then the company's and the mayor's own statements screenshotted on cards in their brand colours. The graphics are built from primary sources, not illustration.
- @wired https://www.instagram.com/p/DdjgfsIgAVa/: 10.17x. An original survey drawn as flat charts in a 4-colour palette, alternating with verbatim quote cards. One solid colour per slide, two type sizes, a persistent watermark, and methodology charts placed late.
- @evolving.ai https://www.instagram.com/p/Ddoiw3jlOvg/: 2.74x (29,420 likes). Covers a model launch with 17 built demos, one short caption bar per slide over the demo itself: proof instead of a spec sheet. This is how Geektime should cover AI launches.
- @calcalist https://www.instagram.com/p/DdqfZIgsPPQ/: Anti-example: 0.09x, the account's worst post (12h old at scrape). The publisher's own TECH1 Awards event poster, in English, with a partner logo and a QR code. It is the closest analog to our GeekAcademy post.
- @geektimecoil https://www.instagram.com/p/DcqIx3ftGow/: Anti-example: 0.57x. Fully on-template (navy plate, card, wordmark) yet flat: a global Google AI travel feature with no Israeli hook, and the caption itself notes the points calculator mostly supports US airlines, not El Al. Following the template doesn't rescue a topic without a local stake.

**Patterns**

- [high] (hook) On Geektime the reader's stake decides the result, not the product. The same iPhone subject runs at a 12.3x median when the post carries an Israeli price or launch-date fact, and at 0.75x when it doesn't. Evidence: With a stake (n=4): B1 'Osher Ad' iPhone 18 Pro at 4,490 NIS 26.5x; B2 Apple cuts iPhone 17 Pro prices in Israel by 320 NIS 16.11x; B4 Israel joins the first launch wave 8.54x; iCloud+ users in Israel get Apple TV and Arcade free 3.68x. Without (n=5): 'what should we test' review reel 2.68x, cleaning-cloth joke 1.11x, iPhone Duo launch specs 0.75x, 'what do we think of the new colour' 0.39x, 'ask us anything' 0.36x. Same template and photographer, and every post was over 24h old at scrape.
- [medium] (hook) Named-person stories are Geektime's second engine. Global AI-company announcements are its weakest regular category, even though they make up most of its AI coverage. Evidence: Named individual built, did or said something (n=5, median 4.11x): Doom on a 16-year-old Canon DSLR 13.36x, Yoav Erez on ChatGPT-written instructions 7.61x, the Blue Star creator's free AI-built sim 4.11x, a 78-year-old engineer's Claude-built parking app 2.14x, Gefilte Invaders 0.64x. Global AI company/model/feature news (n=9 mature posts, median 0.71x): OpenAI ads, Gemini watermark, the Cursor/OpenAI contract, OpenClaw 2.0, Google AI Mode travel, Ox Alpha, 'Claude fired a worker', the Gemini breach, and Nvidia buying Hugging Face (the only one above 2x). WIRED's biggest post uses the same mechanic: a 30-year-old developer's ZuckOff app at 17.35x.
- [medium] (hook) An open question or in-joke with no payoff is the floor on Geektime, and it underperforms across the set. Evidence: Geektime (n=5, median 0.39x): Instagram's new logo question 0.86x, 'what should Rappaport buy next' 1.11x, iPhone colour question 0.39x, 'ask us anything' 0.36x, Comic Sans meme 0.25x. Aggregate: question hooks are 5.6% of best posts vs 13.9% of weakest; how-to/guide hooks 0% vs 11.1%.
- [high] (other) House promotion and partner content sink on every publisher that ran them, and partner logos on the cover mark weak posts. Evidence: Calcalist's own TECH1 Awards poster 0.09x (its worst; 12h old), WIRED live-podcast event 0.07x and app launch 0.23x, Visual Capitalist webinar 0.04x and reader survey 0.13x, TheMarker job ad 0.37x. All 10 Visual Capitalist partner posts sit below median (0.06-0.63x, median 0.43x) against 1.89x for its 26 organic charts. ynet's six weakest are all sponsored or syndicated reels (a same-day cohort), and Evolving AI's worst is #OpenArtPartner (0.21x). Aggregate: other brands' logos appear on 31.9% of weakest vs 12.5% of best. Geektime's sample has no house-event post; its one sponsored post that worked (Connecteam, 2.57x) opened on a person and a human hook, not the partner.
- [high] (imagery) Real imagery carries every Geektime breakout, and processed or AI-labelled images never break out. Real imagery is necessary but not sufficient. Evidence: Geektime's five posts whose credit line says 'עיבוד תמונה', 'עיבוד AI' or 'AI': 1.32x, 0.82x, 0.79x, 0.71x, 0.64x (median 0.79x). All six best posts use real imagery: own product photos (B1, B2, B4), raw video (B3), a reader's photo (B5), a game screenshot (B6). Geektime's own iPhone photos with no-payoff hooks still flopped (W2 0.36x, W3 0.39x). Aggregate: photo-dominant covers 37.5% of best vs 12.5% of weakest; stock-looking 4.2% vs 11.1%; illustration/vector 11.1% vs 25%. People & Computers' AI-stock heroes (robots, glowing brains, synthetic faces) scored 0 likes on all six of its weakest posts. The aggregate 'AI-generated-looking' lift (5 best vs 2 weakest posts) comes mostly from Evolving AI, whose subject is AI video, so it doesn't transfer.
- [high] (design) Geektime's Instagram system is exact and measurable, and every designed cover follows it. Following it is necessary but not sufficient: on-template posts on weak topics still flopped. Evidence: Measured on B1, B2, B4, B6, W4, W5 and W6. Lime frame 2.2-2.3% of width (about #A5E624). Navy #022330 (not the website charcoal #272a35) as a full plate or a tab. The headline sits in a rounded white card nested in a rounded lime slab 1.9-3.0% of width, with the card 73-80% of width. The headline is bold black, 2-3 lines, line height 3.6-4.7% of frame height. The white 'Geektime' wordmark is 24-28% of width, right of centre. Going off-template works only for native payoffs (B3 raw reel 13.36x, B5 photographed manual 7.61x) and fails for teases (W1 meme 0.25x, W2 magenta bubbles 0.36x, W3 bare product 0.39x).
- [high] (font sizes) Winning Hebrew covers use one headline size plus at most one smaller line, and interior slides use a single size. Emphasis comes from colour or weight within that size, not from size jumps. Evidence: Geektime B1: overline 2.3-2.7% of height vs headline 4.4-4.5% (ratio about 0.55-0.6), both bold, same family. Every other Geektime cover has one headline size plus a micro credit line (about 1%). TheMarker B1 interior quote cards use one size (2.3-2.6% of height) for 35-65 words in a charcoal block. israel.business puts the money figure in a second colour within the same line; Calcalist uses a small red kicker pill. Aggregate: headline 'small' 2.8% of best vs 12.5% of weakest; 'huge' 9.7% vs 15.3%; 'large' 51.4% vs 37.5%.
- [high] (layout) Headlines sit in a solid band, card, plate or dark gradient. Only a short line of 7 words or fewer goes straight onto a photo, and only over a dark, flat area. Evidence: Geektime puts a card or navy plate on every designed cover. push.il puts a header card above the photo on 12 of 12 sampled posts. ynet uses a yellow band or dark scrim, israel.business a colour band, Calcalist a white card under the photo, and TheMarker a charcoal text block on interior slides. Geektime B1's 6-word overline sits on the darkest, flattest part of the frame (the maroon phone body). Aggregate: medium text contrast on 1.4% of best vs 19.4% of weakest.
- [medium] (graphics) The graphics that win in news are data and receipts, not illustration: one extreme number, a giant numeral, a primary-source screenshot or quote card, a flat chart. Evidence: Visual Capitalist: US car colours 50.54x and iPhone workdays 5.72x, each one comparison readable in a second. TheMarker 'Secret Passenger': episode 1 with a giant '100' numeral drew 98,716 views; episode 2 with a small lower-third drew 3,270; both over 36h old (episode order is a confound). Morning Brew DoorDash: a pull-quote card plus both statements screenshotted on brand-colour cards, 3.77x. Geektime B1's slide 2 is the retailer's own flyer. WIRED survey charts plus quote cards, 10.17x. Aggregate: big number/stat 9.7% of best vs 1.4% of weakest; illustration/vector 11.1% vs 25%.
- [medium] (format) News carousels win when short and purposeful (hook, then receipt). Long carousels win only when every slide adds a new fact or voice. Evidence: Two-slide winners: Geektime B1 (hook, retailer flyer) 26.5x and B5 7.61x; TheMarker B3 (verdict, court reasoning) 4.17x; ynet B2 (portrait, then the mother's quote) 5.15x. Long winners add something on each slide: TheMarker B1 has a new sub-topic and photo per slide (9.3x); WIRED B3 has 12 slides (10.17x); Evolving AI B3 has 17 demos (2.74x). Geektime's longer carousels without new facts: Googlebook, 5 slides, 1.18x; Kan 11 chatbot, 4 slides, 0.68x; iPhone colour, 5 slides, 0.39x. Interior slides on winning carousels carry a median 29.5 words (n=16). Single images are 75% of Geektime's feed.
- [high] (language) Geektime's caption voice is measurable: conversational, specific and dry, with a fixed close. Evidence: Across 36 captions: median 425 characters and about 12 words per sentence. Hashtags appear on 1 post of 36 (a reel). The article pointer 'הכתבה המלאה בגיקטיים | לינק בביו' (or a story/DM variant) appears on 26, a photo credit line on 19, and an emoji in the first line on 17. No caption has more than one 'לא X.' fragment. Typical asides: 'אז תהיה חגיגה לרכישה עם גלידת פיצוץ?', 'בלי להדליף לראמזי את כל הסיסמאות שלכם, כן?'.
- [medium] (language) Winning cover headlines are an active verb plus a named actor plus a consequence for the reader; weak ones are labels or teases. The shekel figures on the top two posts sit in the caption and on the receipt slide, not on the cover, which corrects the upstream note. Evidence: Winners: ''אושר עד' מרסקת את מחירי האייפון 18 פרו' (26.5x), 'אפל מורידה את מחירי האייפונים בישראל' (16.11x), 'פרסום ראשון! האייפון המתקפל יגיע לישראל מוקדם מהצפוי!' (8.54x), 'היוצר של 'כוכב כחול' חוזר עם סימולטור טיסה חינמי חדש' (4.11x). Weak: 'מייסד Wiz בראיון בלעדי לגיקטיים' (a label), 'OpenClaw 2.0 זמין: בדקנו לכם מה חדש בו' (a tease, 0.5x), 'ה-AI של גוגל יזמין לכם עכשיו מלונות וטיסות' (a global feature, 0.57x). Headlines run 5-9 words in both groups, and aggregate cover words are 13 best vs 11 weakest, so wording separates them, not length.
- [medium] (hook) Israeli availability is part of the stake: 'it reaches Israel early' works, and a global feature with no local hook doesn't. Evidence: B4 (Israel in Apple's first launch wave, pre-orders this Friday) hit 8.54x. W6 (Google AI Mode books flights and hotels) hit 0.57x, and its own caption notes the points feature mostly supports US airlines, not El Al. israel.business W6 (Trump calls Jensen Huang on stage, US AI policy) hit 0.51x despite two famous faces.
- [high] (other) The weak-post evidence is contaminated by posts only hours old and by hidden like counts, so best-post patterns are more reliable than weak-post patterns. Evidence: Age at scrape: all six Calcalist 'worst' posts were 4-12h old; four of Morning Brew's six were fresh (W1 was 18 minutes old); Evolving AI W2 and W4 were 5-6h; WIRED W2 1.8h; push W3 5.6h; israel.business W2 6.1h; Geektime W4 (Wiz CTO interview) 5.4h. israel.business W1 (the ChatGPT/Claude/Grok outage) and W3 have hidden likes (3 likes against 29 and 45 comments). So claims such as 'enterprise interviews flop on Geektime' or 'Morning Brew reels are weak' are unproven. Judge a post only after 24-48h.
- [low] (format) Reels look weak in the aggregate (16.7% of best vs 38.9% of weakest), but the gap comes mostly from sponsorship and freshness, not format. Evidence: Every Visual Capitalist reel and its one carousel are partner posts. ynet's six weakest reels are sponsored or syndicated. Calcalist's weakest reels are sponsored and under 12h old. Geektime's reels include its #3 post (Doom, 13.36x, native footage, no design) and two above-median reels (2.68x, 2.57x).
- [medium] (hook) Exclusivity labels lift a post only when the scoop itself carries a stake. Evidence: Geektime B4 'פרסום ראשון!' plus the early Israeli launch hit 8.54x. israel.business puts 'פרסום ראשון' ribbons on two of its top five posts, both with money figures attached. Calcalist's 'בלעדי לכלכליסט' pill sits on its NVIDIA Israel post (3.56x). 'בראיון בלעדי' on Geektime W4 (the Wiz CTO, no reader stake) sat at 0.39x, though that post was only 5h old.
- [medium] (language) Across business accounts, a person's voice (a quote or a personal figure) beats a flat announcement, and hype underperforms. Evidence: TheMarker B1's cover quote from the bookstore CEO hit 9.3x. Globes B3's quote box about a refused 300M NIS offer hit 9.28x, and all six Globes best posts are named people. ynet B3's quote hit 5.04x; Morning Brew B3 uses the mayor's pull-quote. Aggregate: quote hooks 11.1% of best vs 4.2% of weakest; emotional/personal register 12.5% vs 5.6%; hype/promotional 8.3% vs 15.3%; fragment/label sentences 22.2% vs 34.7%.
- [low] (hook) The same corporate story with the same photo lands at nearly the same rate per follower; framing it around people's money helps only modestly. A corporate exit is a mid-table topic, not a breakout one. Evidence: The RealSense $600M sale, with the same team photo, both posts about 55h old. Calcalist led with the staff payout ('העובדים יהפכו למיליונרים'): 186 likes, 0.22% of followers (3.37x its low median). TheMarker led with the corporate fact: 62 likes, 0.17% (0.31x its higher median).
- [medium] (other) Comment prompts work when they ask for something concrete and easy after the fact is delivered. A generic 'what do you think' doesn't set winners apart. Evidence: Geektime's iCloud+ post asks readers to drop series recommendations (3.68x). B1 drew 49 comments with no question at all (price talk). ynet: 5 of 6 best posts end with a reply prompt. Evolving AI: all 12 tagged posts end with a question, winners and losers alike.

**Our post against these patterns**

- The topic has no reader stake. It's a Geektime house programme (GeekAcademy with Microsoft) framed as enterprise AI adoption. → Don't run GeekAcademy as news. Cover it only when the reader gets something: a next session with a sign-up date, a free seat, or a named graduate who built something (the Blue Star and parking-app pattern). Label it plainly as Geektime's own programme and keep Microsoft off the cover.
- The headline stat is 15 months old and presented as news. → Add a freshness gate: the lead fact must be 7 days old or less, or carry its date on the slide. If the only number is old, it can't be the headline.
- The headline is a reach metric for the publisher, not a consequence for the reader. → Write 5-9 words: a named actor, an active verb, and what changes for an Israeli reader. If a number goes on the cover, make it the reader's (a price, a saving, a date, 'חינם'), in digits.
- White plate with a dead band: the top 21% of the canvas holds only a 3%-wide glyph. → Use the navy-plate template: #022330 over the top 45-50%, holding the wordmark top-right (8-13% of height) and the card below it (about 15-45%), with a real image or graphic in the lower half and a credit line bottom-left. Add #022330 to the kit as the Instagram dark. Keep the 3:4 canvas and the 2.3% lime frame, which are already right.
- The headline box isn't Geektime's card. → Render a rounded lime slab (about 2.5% of canvas width) with a rounded white card inside it, 75-80% of width, text centred, and the navy wordmark tab overlapping its top-right edge.
- Wrong font, set too light. → Set the kit's heading and body font to Open Sans (the site's own face; confirm the weight against B2 and B6), with headlines at 700-800 and one family for Hebrew and Latin words. Keep the current headline size. Block renders whose kit font lacks Hebrew glyphs for a Hebrew client, and flag the resolver when it reads a challenge page.
- The logo is the profile-disc glyph, far too small and on the wrong side. → Add the horizontal wordmark to the kit (the site serves cdn.geektime.co.il/wp-content/uploads/2024/09/geektime-logo-2.svg; a white variant is needed for navy). Render it at 24-28% of width on the navy tab, right of centre. Never use the profile disc on a post.
- The photo is AI-generated and shows a real-seeming event that never happened as pictured. → For news, use a real, credited photo (Geektime or partner event photography, or a press image), a screenshot, or a house-template graphic. Never generate a scene presented as a real event or real people. If AI art illustrates a concept, label it 'תמונה: עיבוד AI' as Geektime does.
- Spec text was silently dropped at render. → Render a second line only as Geektime's overline (white bold, about 0.55-0.6x the headline, 7 words or fewer, on the navy plate or a dark flat photo area), or drop it at brief time. Fail the render check when any spec text is missing from the output.
- The caption reads as AI copy and breaks Geektime's conventions. → Rewrite in Geektime's shape: a one-line hook with one emoji, then two or three short paragraphs of roughly 12-word sentences with the concrete facts and one dry aside. Close with 'הכתבה המלאה בגיקטיים | לינק בביו' plus the link emoji, then 'צילום: ...'. No hashtags and no first-comment footnotes. Fix the question to 'מה הייתה ההכשרה שאחריה השתנתה הגישה שלכם?' and 'yיותר' to 'יותר'. Add a Hebrew proofing step: gender agreement, stray Latin letters, and at most one 'לא X.' construction.
- No graphic device: the post is a card plus a generated photo. → When a story has numbers, draw them inside the house template: a giant numeral on the navy plate, a price-comparison bar (importer vs retailer vs US), a US-vs-Israel launch-date strip, or the source document as slide 2. A Geektime-ready idea: 'how many workdays an Israeli needs to buy an iPhone 18 Pro', after Visual Capitalist's 5.72x chart.

**Client rules (L3)**

- Every post needs a stake an Israeli reader can act on or feel this week: a shekel price or saving, an Israeli launch or availability date, something free, or a named person's story. Run global AI-company announcements (median 0.71x) only with an Israeli angle or a working demo.
- Don't run house programmes (GeekAcademy, Geektime events, Insider) as news. Run one only with a reader hook (a sign-up date, a free seat, a named graduate's result) and a real, credited photo, and keep partners such as Microsoft off the cover.
- Cover headline: 5-9 words on 2-3 lines, built as named actor + active verb + consequence (the 'אפל מורידה את מחירי האייפונים בישראל' shape). No publisher reach metrics. Use 'פרסום ראשון!' only for true scoops that carry a stake.
- Lead facts must be 7 days old or less, or dated on the slide. Never present an old milestone with 'הגיעה' or another news verb.
- Real-photo template: full-bleed real photo, lime #A5E624 frame at 2.3% of width, the card in the lower third (about 65-88% of height), and the navy #022330 tab carrying the wordmark tucked behind the card's top-right corner.
- Navy-plate template: #022330 over the top 45-50%, with the wordmark top-right (8-13% of height) and the card below it (about 15-45%). Put a real photo, screenshot or graphic in the lower half and a credit line bottom-left at about 1% of height. Never use a white plate.
- Card: a rounded white card inside a rounded lime slab 1.9-3.0% of canvas width (about 2.5%), 73-80% of width, text centred. Never square corners, never a thin outline, never a card floating in empty space.
- Type: Open Sans, the site's own face (confirm the weight against B2 and B6), at 700-800 for Hebrew and Latin alike. Headline line height about 4.4% of canvas height (range 3.6-4.7%). At most two sizes on a cover: the headline plus an optional overline of 7 words or fewer at about 0.55-0.6x, white bold, placed only on the navy plate or a dark, flat photo area. Credits at about 1%.
- Logo: the white horizontal 'Geektime' wordmark at 24-28% of canvas width on the navy tab, right of centre. Never the profile disc, never top-left, never under 20% of width.
- Imagery, in order of preference: Geektime's own product photography (a hand-held device, credited 'צילום: גיקטיים'), then vendor press images, then screenshots or receipts. No AI-generated scenes of real events or people. Concept art only when labelled 'תמונה: עיבוד AI' in the credit.
- Graphics: when the story has a number, draw it in the house palette (navy, lime, white), as a giant numeral on navy, a price-comparison bar, a US-vs-Israel launch strip, or the source document as slide 2.
- Format: single image by default (75% of the feed). Use a carousel only as hook then receipt (2 slides), or when every added slide brings a new fact or photo. Never add a slide that restates the cover.
- Caption: 300-500 characters, opening with a one-line hook and one emoji. Write about 12-word sentences with the numbers in digits and one dry aside. Close with 'הכתבה המלאה בגיקטיים | לינק בביו' plus the link emoji and 'צילום: ...'. No hashtags, no first-comment source notes, no English corporate jargon, and at most one 'לא X.' construction. A comment prompt asks for something concrete (a recommendation, a guess), not 'מה דעתכם'.
- Run a Hebrew proofing gate before publish: gender and number agreement, and no Latin characters glued to Hebrew words.
- Fix the brand kit before the next run: heading and body font Open Sans (Inter has no Hebrew), Instagram dark #022330, and the horizontal wordmark with a white variant as the post logo.

**Industry rules (L2)**

- Lead with what changes for the reader (a price, availability, money owed, something free, a deadline), not with the company's announcement. On Geektime the same topic swings from 0.75x to 12x on that alone.
- Put a named person on the cover when the story has one: a maker, a user, or an executive with a personal figure or a quote. Named-person stories beat institutional ones on Globes, TheMarker, ynet, WIRED and Geektime.
- Keep house promotion and partner branding out of the news slots. When one must run, give the reader something concrete and keep partner logos off the cover: partner posts ran 10 of 10 below median on Visual Capitalist, and house events were the worst post on Calcalist and WIRED.
- Real photography first, data graphics and receipts second, generated imagery last and labelled. Never generate an image presented as a real event or real people. Generic AI 'tech' heroes (robots, glowing brains, synthetic faces) are the floor.
- Use one bold headline size on 2-3 lines, inside a solid band, card, plate or dark gradient, with at most one secondary line at about 0.55-0.6x. Interior slides use one size (about 2.3-2.6% of height for 30-60 words). No tiny text, no paragraphs floating on a photo, no medium-contrast type.
- Make each graphic carry one comparison readable in a second: an extreme number, a giant numeral, a ranked bar, a before/after price, or a primary-source screenshot or quote card. Illustration for its own sake underperforms.
- News carousels: hook then receipt in two slides, or longer only when every slide adds a new fact, voice or photo. Keep about 30 words per interior slide, skip recap and CTA slides, and never repeat the cover.
- Hebrew RTL: set Hebrew in a font with native Hebrew glyphs and use the same family and weight for Latin names. Anchor the logo and the reading start at the top-right or right of centre.
- Write captions in complete, specific sentences of about 12 words, 300-650 characters, closing with a clear pointer to the full story and a photo credit. Avoid staccato 'not X. Y.' fragments, hype and corporate jargon.
- An open question is not a hook. Ask only after the post has delivered the fact, and ask for something concrete.
- Exclusivity labels ('פרסום ראשון', 'בלעדי') help only when the scoop itself carries a stake.
- Measure a post only after 24-48 hours and exclude posts with hidden likes; hours-old posts and hidden counts are not evidence that a format or topic failed.

## Client synthesis: hankypanky

**Best creators**

- hankypanky: The model to copy is the client itself. Its best non-pinned posts are real shoots in saturated Signature Lace colours on candid, laughing women in real rooms and outdoors, with no text on the image and a one-line cheeky caption: B2 (4 slides, 2.13x), B4 (3 slides, 1.96x, 27 comments), B5 (2 slides, 1.9x, 33 comments), plus the 5-thong flat-lay reel (3.54x, the top non-pinned post). Carousels are its strongest format: median 1.15x across 16 carousels against 0.71x across 17 reels.
- savagexfenty: Highest in-house multiples in the set with almost no digital text: 5 of its 6 best carry none, captions stay under 20 words, and the brand name appears physically (the NYC lingerie-shadow installation, 37.69x as a carousel and 18.95x as a reel). Its 6 weakest are plain studio shots of a basics line with feature-listing captions.
- skims: Wins on occasion, never on product: all 6 best are an event, a celebrity collab or a city stunt, and all 6 weakest are product-on-model shots with seasonal copy. When it wants lettering it builds it from real objects (pastry letters on pies 4.76x, a tiled subway-style sign 6.42x) instead of adding an overlay.
- aerie: Runs the two engines that need little or no text: a swatch quiz with no photo ('which one is aerie green?', 10.69x, 23,106 likes) and 10-slide creator diaries with zero text (5.94x, 5.83x). Its 6 weakest are the reverse: 5 carry Instagram caption-sticker text. Its most-liked post overall is a pinned #NotAI 'REAL people' carousel (45,841 likes).
- lovestoriesintimates: Cleanest carousel craft in the set: all 5 outliers are carousels, none has overlay text, the wordmark appears only on real objects (booth awning, a label shot as the cover at 3.08x, ribbon), and product slides are one colourway per slide on white (2.09x). Its one template-overlay post (large 'Style Stories' script across a street photo) is 0.36x.
- thirdlove: Closest DTC peer. Organic winners are candid mid-action frames (crouched at an oven, pulling a sweater over a bra) with zero text and short, finished captions ('The layers are back. Make the first one count.', 2.24x, 154 comments); both of its best carousels are 2 slides. Its losers are faceless crops, a flat lay, a store interior and press-release captions (636 characters, 0.22x).
- btemptdbras: Clearest example of graphics built from product: its top post (2.91x) puts all the reading on one meme slide, then runs four wordless boards of cut-out product and outfit pieces. The same device fails when it turns into a dense pitch: a headline-plus-arrow outfit board with eight cut-outs sits at 0.52x, and a reused 'Team Edit' card at 0.49x.
- felinaintimates: Design reference only. Its labelled feature photo (three thin leader lines, one short serif label each, one size, no boxes) is the tidiest way to explain a comfort benefit as a graphic. Likes are hidden on 32 of 36 posts and median engagement is 3, so its rankings are weak evidence.

**Best content**

- hankypanky https://www.instagram.com/p/Dak_u1-zFTR/: Top non-pinned post (3.54x, 47 comments, 8,676 views). Five Signature Lace thongs in five saturated colours laid on a yellow-and-white striped towel with loose gerberas: the product arrangement is the graphic, and there is no text on the image. The caption wraps the offer in a joke and names the pack ('Commitment issues, but make it cute. / Why pick one? When you can have 5 in our Matchbox 5 pack.'). The same idea done badly is W2, one purple set dropped on grass, at 0.42x.
- hankypanky https://www.instagram.com/p/DdMXXqCCbgK/: 4 slides, 2.13x, no text on any slide. Opens on an unposed sleepover moment on a mustard bed, then a solo poolside toast in teal lace, a laughing trio in a garden, and closes on a clean blush-studio shot with the set fully visible. Every slide is a new setting, and the colour settles from saturated to white at the close. Caption is one fragment: 'Somewhere between catching up and causing trouble.'
- hankypanky https://www.instagram.com/p/Da0cecvieqd/: 3 slides, 1.96x, 27 comments. One location (white lace against sage-green tile) from three angles: a playful hand-over-eyes 'caught' gesture, a side-profile fit detail, then a smiling camera-facing close with the set fully visible. It sells fit with no copy at all.
- hankypanky https://www.instagram.com/p/DdUpRFbk5L3/: The client's only headline treatment in the sample: 8 words ('What we'd wear under the Emmys Best Looks'), one size (about 56px on a 1080 canvas, 3.1% of frame height), light white display type, two centred lines in the bottom third spanning 60% of the width, with no box and no logo. This is hot-news done the client's way: a live cultural moment tied to what's underneath.
- aerie https://www.instagram.com/p/DdRbJowRzwC/: 10.69x, 23,106 likes, 1,326 comments; its most-liked non-pinned post. A script question over eight numbered swatch bars and no photo: the game is visible in the image and costs nothing to play. It transfers directly to Signature Lace using the site's own colour names and hex values.
- wearcommando https://www.instagram.com/p/DbmGeHyoH1x/: The same swatch quiz on a second account ('Which one is Commando Pink?', four numbered bars in the brand pink, 2.84x, 16 comments). Its text-over-photo campaign tiles (Campus Capsule, Styled By You, Mink) all sat between 0.12x and 0.36x.
- felinaintimates https://www.instagram.com/p/DdKcFc_ShnC/: A labelled feature photo: three thin white leader lines with dot ends, each pointing at a real feature, with one short sentence-case label each, one type size, no boxes, and labels placed on darker parts of the frame. It shows why a product is comfortable without a text card. The 4.0x is weak evidence (12 likes against an account median of 3).
- btemptdbras https://www.instagram.com/p/DXk0LXsj1RO/: 5 slides, 2.91x. All the reading sits on slide 1 (a film-still meme set up with the brand's question), then four wordless boards built from cut-out product and outfit pieces plus one scene photo each. These are graphics made from product, with zero words on each interior slide.
- lovestoriesintimates https://www.instagram.com/p/DcLecWvDbpP/: 6 slides, 2.09x. One matching set per slide, flat on white, identical light and crop, no text: the simplest colourway sequence. Hanky Panky's colour range supports the same format with real thongs from the client library.
- savagexfenty https://www.instagram.com/p/DdMsFnqjwYP/: 37.69x, 4 slides. A reveal sequence: a street canyon with a shadow on the pavement, the shadow from overhead, the rigged lingerie that casts it, then the fully legible 'SAVAGE X FENTY' shadow with a yellow cab crossing. There is no digital text; the name lives in the scene and the last slide is the payoff.
- skims https://www.instagram.com/p/Ddg3A6hIKfK/: 4.76x, 2 slides. 'SKIMS' spelled in pastry letters on pies plus a Union Jack heart pie, shot overhead on white. In this category, lettering made from real objects counts as a graphic; there is no overlay type.
- thirdlove https://www.instagram.com/p/DcoSO8OoDr1/: 2 slides, 2.24x, 154 comments. One continuous moment (pulling a knit sweater over a bra and brief) from two angles in natural window light, with no text. The caption is short and finished: 'The layers are back. Make the first one count.'
- somaintimates https://www.instagram.com/p/Dcf0UU4E5wp/: 43.8x Real Talk reel (122,461 views). The cover titles a photo with only two sizes: an italic serif headline and a smaller bold caps line naming the two women, in white, lower third, with no scrim. The solo instructional spin-off of the same series sits at 0.32x and 0.5x.

**Patterns**

- [high] (imagery) Saturated, real Hanky Panky product on real people is this client's currency. AI and stock imagery have no precedent anywhere in the set. Evidence: Measured share of vivid pixels: the client's 6 best covers have a median of 64% (B2 75%, B3 77%, B5 71%) and its 6 weakest 39%; the two least colourful covers are both weak (W4 collage 19.5%, W6 OOTD 11%). None of the 144 tagged best and weakest posts across the 12 accounts reads as AI-generated or stock. Aerie's most-liked post is its pinned #NotAI 'REAL people' carousel (45,841 likes, 19.05x), paired with a reel committing to 'No AI-generated people or bodies'.
- [high] (design) Nobody in the category stamps a logo or handle on the image. The name appears in the scene or not at all. Evidence: Hanky Panky has no mark on any of 12 covers or 7 full carousel slides. Elsewhere the name is physical: the SKIMS store sign, tiles and pies; Savage X Fenty's street shadows; Love Stories' awning, label and ribbon; Negative's wheatpasted poster; a backdrop card at Natori. The only overlay logos are Thirdlove's giveaway card (7.51x, driven by contest mechanics) and Commando's Campus Capsule tile (0.12x).
- [medium] (font sizes) When winners put text on an image they keep it to one or two sizes with a medium headline, about 50-65px on a 1080-wide canvas. Evidence: Across the client's accounts a medium headline appears on 16.7% of best posts vs 6.7% of weakest (lift 2.2), a huge one on 5% vs 6.7% (0.8); two text sizes 11.7% vs 6.7%, three sizes 3.3% vs 6.7%. Hanky Panky B6 uses one size, about 56px. Soma's Real Talk duo covers (43.8x, 12.89x) use two: a serif headline about 3.5% of frame height and caps names about 2.5%. Felina's callouts use one. Weak covers stack treatments: Soma's solo 'Confessions' covers (masthead, two-size title, 'PART 3' tag) at 0.32x and 0.5x; Aerie's three-layer 'POV' reel at 0.28x.
- [medium] (layout) Text over a photo works when it is short and sits on a naturally dark area or a solid strip. Long or stacked overlays lose. Evidence: Hanky Panky B6: 8 white words, one size, bottom third. Natori B4 (4.67x): a 7-word italic line on a white label strip over a busy archival clipping. Losers: Savage X Fenty W1 (0.32x), 12 words stacked one per line down the photo with no shade; Love Stories W3 (0.36x), large script across the photo; Commando's headline-over-photo tiles at 0.12x. A headline on a photo is fine in itself: 'full-bleed photo + overlaid headline' is 26.7% of best vs 15% of weakest (lift 1.7).
- [medium] (language) Hanky Panky writes short, flirty fragments with a recurring mischief vocabulary. Polished complete-sentence taglines do worse. Evidence: Its 36 captions have a median of 45.5 characters, a maximum of 148 and zero hashtags. 4 of the 6 best use the vocabulary ('causing trouble', 'Guilty as charged', 'Caught in the act', 'a little Hanky Panky underneath') vs 0 of the 6 weakest, and 4 of the 6 weakest are complete taglines ('Summer never looked so hot.', 'Questionable decisions make the best memories.', 'A pop of color does all the heavy lifting.'). Across the client's accounts, complete sentences are 20% of best vs 30% of weakest (lift 0.68), and an emotional/personal register lifts 2.67.
- [medium] (hook) Occasions, people and participation outperform product explanation. Nobody wins by criticising cheaper product. Evidence: Lifts across the client's accounts: event recap 5 (6.7% vs 0%), story/narrative 2.25, comment-prompt CTA 3.5 (mostly contest entries); how-to/guide 0.67, product promo/offer 0.74, no hook 0.5. At SKIMS the 6 best are events or stunts and the 6 weakest are product-on-model. At Savage X Fenty 5 of 6 best are Rihanna or the street stunt and the 6 weakest are basics product shots. Only 1 of 432 captions across the 12 accounts takes the itchy-lace angle (Soma, 'Bye—itchy, scratchy lace'), and it sits at 0.75x.
- [medium] (graphics) Graphics that work in this category are made from the product and brand colour, stay sparse and carry one idea. Generic panels and dense boards don't carry. Evidence: Swatch quizzes: Aerie 10.69x (23,106 likes), Commando 2.84x. Product arrangements: Hanky Panky's 5-thong flat lay 3.54x, Love Stories' colourway grid 2.09x, b.tempt'd's wordless cut-out boards 2.91x. Real-object lettering: SKIMS 4.76x and 6.42x. Labelled feature photo: Felina 4.0x (weak metrics). Failures are busy or generic: Hanky Panky's scrapbook collage (about six focal points, two handwritings, 0.46x, 0 comments) and b.tempt'd's headline-plus-arrow board with eight cut-outs (0.52x). Boxes/cards are neutral across the set (10% of best vs 8.3% of weakest). The game has to be in the image: Hanky Panky's 'vote which is your guess' reel showed a dim mirror selfie and is its weakest post (0.39x).
- [medium] (format) Carousels are the client's best format. Slide count isn't what matters; a new picture on every slide is. Evidence: Hanky Panky carousels median 1.15x (n=16) vs reels 0.71x (n=17); 4 of its 6 best are carousels vs 0 of its 6 weakest. Long carousels win where every slide is a photo: SKIMS 5+ slides median 2.94x, Negative 3.42x, Aerie 1.92x, Love Stories 1.37x. Across the client's accounts best posts have a median of 2 slides vs 1 for weakest, and best carousels carry a median of 0 words per interior slide (n=19).
- [medium] (layout) Winning carousels open on a candid moment and close on their most direct, product-visible frame. None closes on a recap panel. Evidence: Hanky Panky B2 closes on a camera-facing blush-studio laugh and B4 on a smile with the set fully visible; Savage X Fenty B1 closes on the fully legible name; Aerie's beach diary closes by repeating its first pose; Natori's WWD carousel ends on its boldest print. No best carousel captured slide by slide ends on a text recap or CTA card.
- [medium] (imagery) Candid, in-motion faces beat anonymous crops and flat product documentation, though a posed face alone doesn't rescue a generic product post. Evidence: Faces appear on 7 of the 12 tagged Hanky Panky covers, and its best carousels open on candid gestures. Thirdlove's weakest are a no-people store interior, a flat lay and face-cropped close-ups, while its winners are candid mid-action. At Natori, 3 of 6 weakest hide the face vs 1 of 6 best. Counter-case: 5 of Love Stories' 6 weak covers show a face square to camera.
- [high] (language) Long captions only win when they carry contest rules. Evidence: All four best-set captions over 600 characters are giveaway or sweepstakes entry rules (Soma three times, Aerie's 1,437-character giveaway). The two long non-giveaway captions sit below median: Thirdlove's store-design press copy (636 characters, 0.22x) and its NYFW lookbook (920 characters, 0.84x). The '>600 chars lift 6' in the stats is a giveaway artifact.
- [high] (other) Creator co-posts, giveaways and hidden likes distort the rankings, so design targets should come from in-house organic posts. Evidence: Commando's top three (91x, 22x, 19x) are creator-authored co-posts; Aerie B3, B4 and B6 are #AeriePartner posts; Natori's only real viral post (48.67x) is by a creator. Giveaways: Negative 174.86x (611 comments), Aerie 16.59x (9,855 comments), Soma 11.05x, Thirdlove 7.51x (1,480 comments). Likes are hidden on 32 of 36 Felina posts, 35 of 36 Natori posts and all 36 Negative posts, so those accounts rank on comments alone.

**Our post against these patterns**

- Fonts are not Hanky Panky's. → Set the kit to Relais Display for headlines and Fabriga for everything else, using the client's files and licence. Set headlines at 400 and never bold; drop the monospace role entirely. Make the site-font reader ignore third-party widget CSS (Yotpo) when it picks the heading face.
- Text sizes swing from huge to tiny, with nine sizes in one post. → Use one two-step scale for the whole post: headline 52-60px, support line 30-34px, nothing under 28px, and no more than two sizes on a slide. No display numerals or stat figures; if a number matters, it goes inside the headline at headline size.
- Sentences are open-ended and read like AI. → Each on-image line is one finished statement of 8 words or fewer about something concrete: a named product, pack, colour or price, or what the photo shows. Write in the client's playful register (their best: 'Guilty as charged', 'Caught in the act / of romanticizing the afternoon'). Ban 'X didn't..., Y did' and 'not X, Y' constructions, trailing ellipses and dangling pronouns. Exempt this client from the gate's contrast template.
- The boxes don't look like the client's design language. → No panels, cards or gradients. If a slide has to be text-only, set it on a flat full-bleed ground in one official Signature Lace colour from the site (for example Chai #ebd8c3, Marshmallow #f3eee7, Bliss Pink #f7e1ed) with the text directly on it. Otherwise the text lives on a photo.
- Logos are badly sized and placed. → Remove the corner wordmark and the handle footer from every slide. If a logo is required, use the kit SVG once, on the final slide, centred, at about 30% of the canvas width on a clean ground. Leaving it off entirely matches the client's own feed.
- Photo slides carry too much text, with a white wash instead of a shade. → Put 8 words or fewer on any photo slide, in one size: white Relais Display over a real shade (a gradient to about 45% black across the lower third) or over a naturally dark area. Move body copy to the caption.
- Slides repeat. → Every slide adds a new picture or a new fact, and there is no recap slide. Close on a camera-facing product frame, with the named pack and price in the caption.
- The post is text-heavy: about 240 words across 8 slides. → Cap on-image text at 25 words for the whole carousel and 8 per slide, and make at least 4 of 5-6 slides photos or product graphics. Lower the word gate for this client to 10 words per slide.
- The pictures are AI and stock, with no Hanky Panky people. → Use client-library photography only for this client: saturated Signature Lace colours, candid smiling faces, real rooms. No AI-generated people or lingerie and no stock. When the library has nothing that fits, use a product-graphic slide instead of generating a scene.
- There are no graphics. → Brief at least one product graphic per carousel: (a) a 'Which one is Chai?' swatch quiz using the site's colour names and hex values, with the game visible in the image; (b) a lace close-up with at most three thin leader-line labels in one small Fabriga size; or (c) a styled multi-colour flat lay or grid of real thongs from the client library.
- The topic and tone are wrong for this brand. → Carry comfort the client's way: the claim it already owns ('World's Most Comfortable Thong®', from the bio) on a candid photo with a playful line of 8 words or fewer. In hot-news mode, use a cultural moment tied to what's underneath (the B6 Emmys model) with client-supplied or licensed images.
- The caption and first comment are off-register. → Keep the caption to 150 characters or fewer: one playful line plus an optional line naming the pack or colour (the B1 model). No hashtags and no source-citation comment.
- Some claims are unverified, and the quote is stale and about a different product. → Use only product facts that appear on the client's product pages or in documents the client supplied. Quotes must be verbatim, current and about the product shown.
- The run's own checks caught problems and the post shipped anyway. → For this client, make the word-budget and value-judge failures blocking. Add checks for font family against the kit, for the number of distinct sizes (two or fewer), for logo and handle marks on photo slides, and for AI-generated images of people or lingerie.

**Client rules (L3)**

- Type: Relais Display for headlines and Fabriga for everything else (both self-hosted on hankypanky.com; get the files and licence from the client). Weights 400/500 only, with Relais italic allowed for emphasis. No Georgia, Helvetica or monospace, and nothing bold. Update the portal kit: fontHeading Georgia becomes Relais Display, fontBody Helvetica Neue becomes Fabriga.
- Sizes: one two-step scale per post on a 1080-wide canvas, headline 52-60px (the client's own B6 headline is about 56px) and support line 30-34px. Nothing under 28px, no display numerals or stat figures, and never more than two sizes on a slide.
- Word load: at most 8 on-image words per slide and 25 per carousel, with one line group on any photo slide. Everything else goes in the caption.
- Caption: 150 characters or fewer (the client's longest in 36 posts is 148). One playful line plus an optional line naming the pack, colour or product; no hashtags and no citation first comment.
- Voice: witty and flirty, in finished lines that name something concrete or point at what the photo shows. Use the brand's vocabulary (caught, guilty, evidence, trouble, mischief, underneath) without forcing it into every line. Never 'X didn't..., Y did' or 'not X, Y' constructions, no trailing ellipses, no fibre chemistry, and no shaming of competitors, prices or the reader ('your last pair').
- Imagery: client-library photography only, with saturated Signature Lace colours, candid laughing faces, and real rooms or outdoor settings. No AI-generated people or lingerie, no stock and nothing desaturated; match the vividness of the best covers (median 64% vivid pixels).
- Graphics: product-built and sparse, one idea per slide. Options are a styled multi-colour flat lay or grid of real thongs with an offer (the Matchbox 5-pack reel, 3.54x); a swatch quiz with the game visible in the image, using the site's colour names and hex (Black #000000, White #ffffff, Marshmallow #f3eee7, Chai #ebd8c3, Vanilla #fde6cb, Bliss Pink #f7e1ed, Taupe #d0a48e, Macchiato Brown #7b4a30, Red #d41322, Dark Pomegranate Red #a81e48); or a lace close-up with at most three thin leader-line labels in one small Fabriga size. No collages (the client's own W4 collage scored 0.46x).
- Grounds: no boxes, cards, panels or gradients. A text-only slide sits on one flat colourway ground with the text directly on it.
- Text on photos: white Relais Display in one size in the bottom third, over a real shade (a gradient to about 45% black across the lower third) or a naturally dark area. Never dark text on a white-washed photo.
- Logo: nothing on photo slides and no @handle footer. At most, the kit SVG appears once on the last slide, centred, at about 30% of the canvas width; no logo at all also matches the client's own feed.
- Structure: carousel of 3-6 slides (the client's carousels median 1.15x vs 0.71x for reels). Open on a candid moment, change setting or angle on every slide, and close on the most direct camera-facing product frame. Name the pack and price in the caption, never on a recap slide.
- Topics: cultural moments tied to what's underneath (the Emmys trend-jack) using client-supplied or licensed images; pack and colour drops wrapped in a joke; friends-and-mischief moments in step with the live @graceann_nader campaign. Comfort rides on the claim the brand already owns ('World's Most Comfortable Thong®'), never on an explainer that runs down cheaper lace. Exempt this client from the value-signals 'X is not the reason, Z is' cover template, and make the word-budget and value-judge checks blocking.

**Industry rules (L2)**

- Photograph real people in the real product. No AI-generated bodies or lingerie and no stock: none of the 144 tagged best and weakest posts across 12 intimates accounts reads as either, and Aerie's most-liked post is a #NotAI commitment.
- Keep logos and handles off the image. When the brand name appears, it is part of the scene: signage, a label, packaging or an installation.
- Treat on-image text as an exception, reserved for a mechanic (giveaway, quiz), a named person or story, an event, or a label pointing at a product feature. When used: 8-10 words at most, one or two sizes, a medium headline (about 50-65px on a 1080 canvas), white on a naturally dark area or a solid strip.
- Build graphics from the product and brand colour (swatch quiz, cut-out board, colourway grid, labelled feature photo, lettering made of real objects). Keep them sparse with one idea, and put any game or mechanic in the image. Avoid text panels, gradients and dense boards.
- Lead with an occasion, a person or participation. Product explanation, seasonal taglines and how-to hooks underperform (lifts 0.67-0.74), and running down cheaper product has no winning precedent in the set.
- Keep captions short (account medians run from 27 to 155 characters). Long captions only pay off when they carry contest rules.
- In a carousel, every slide is a new picture. Open on a candid moment and close on the clearest product-visible frame, never on a recap card. Length is fine when every slide is a photo.
- Prefer candid, in-motion faces to anonymous crops and flat product documentation. A posed face on a generic product shot doesn't save it.
- Let the product colourway set each post's palette instead of a template colour or gradient.
- Benchmark design against in-house organic posts. Discount creator co-posts and giveaways, and treat accounts with hidden likes (Felina, Natori, Negative) as comment-ranked, low-confidence evidence.

## Client synthesis: kindlyyours

**Best creators**

- @oeak_official: The closest commercial twin to Kindly: a mass-price ($10-20) wireless 'jelly bra' brand that sells through Amazon. It is also the only peer with likes visible on all 36 posts, so its contrasts are clean. Three mechanics move its small account. (1) A named product + BUY 1 GET 1 + 'Comment "Link" and we'll DM you the link' (DbtGBGLHxXg: 23,329 views, 8.5x its 2,751 reel median; 140 comments on 95 likes). (2) A finite-choice quiz card ('Which team are you on?' A-D) got 118 likes, against 7 for a statement card on the same pink template. (3) The proof that a repeated ask wears out: the same DM ask fell to 0.5-0.8x views by September. Its system is one rounded sans, a centred wordmark and real product cut-outs, so Kindly can rebuild it from its own product shots.
- @meundies: The cleanest natural experiments in the set (likes visible on 35 of 36). Its US Open giveaway (Db4CWrfEqb1) drew 250 likes and 297 comments; the same tennis print two days later without the giveaway drew 54 and 4. Its National Underwear Day card ('TELL US WHAT PRINT WE SHOULD MAKE NEXT.': one condensed face in two sizes, wordmark top-centre, one product cut-out, the ask printed on the card) drew 77 comments against a median of 4. Its 57 likes sat under the 103 median, though: asks buy conversation, giveaways buy reach. Its best carousels put every word on slide 1 and leave the product slides wordless.
- @honeylove: The design benchmark and $69 price anchor for Kindly's crossover bra, per the lab competitor analysis. Its funnel is verified on reach, not just comments: 15 reels that name a product and ask 'Comment LIFT/SHAPE for the link' run at a median of about 1.5x the account's reel views. The CloudShape pre-order (DcwJkbClLtl) hit 144K views (4.6x) and 2,357 likes (16.9x). Covers carry no text; the product name and the ask live in the caption. Its two viral hits (2.06M and 246K views) are creator collab posts, which is borrowed reach. Caution: all six of its 'worst' posts are hidden-like placeholders, so disregard that half of its analysis.
- @knix: The best question-card system in the set: flat cream ground, one serif at one size, the lowercase wordmark bottom-centre, nothing else. 'Tell us your bra problem, and we'll tell you which style to try.' (DdE9EQBGP5M) drew 67 comments. The 'would you rather' QOTD (DdenHg7E4r1, 107 comments, 3.8x median) splits one sentence across two cards and closes on a photo of the team's real whiteboard tally, which proves someone reads the replies. The fit-matching card is the most transferable idea for a size-inclusive, wire-free brand.
- @aerie: The size-inclusive category leader. The most-liked post in the whole scrape is its pinned pledge 'We believe in REAL people... #NotAI #NoAI' (DPluyO-EdaY, 45,841 likes, 19x its median). Creator day-in-the-life carousels (#AeriePartner, 10 wordless slides, product worn at the bookends) reach about 6x median likes, while its own brand joke reels sit at 0.17-0.28x. A brand-colour game with no product photo ('which one is aerie green?': 8 numbered swatches, each carrying the wordmark) drew 23,106 likes (9.7x).
- @tomboyx: Shows how to make a joke sell. 'INSIDE YOU THERE ARE TWO BATS' (Dcy-p_WAYK-) puts about 16 words in one caps face on slide 1, the print full-bleed and text-free on slide 2, then two numbered 1-6 product grids naming every piece on a solid colour ground (11,765 likes, 14x its visible-like median of 834). It also rides dated moments (Fat Bear Week + Bisexual Awareness Week, 5,998 likes) and uses share-bait captions ('Send this to a friend who...'). Caveat: 27 of 36 posts hide likes, and its B4-B6 are only average once the placeholders are removed.
- @pact: The credential-led peer (GOTS organic cotton) and the model for how Kindly should carry its USDA plant-based cup. The credential works best as a creator's first-person discovery ('you found THE leggings but ... breathable organic cotton', 66K views) or next to a big giveaway. In DdOXZkhRGbA, 'GIVEAWAY', the circular GOTS seal and the serif wordmark sit stacked on the empty wall of a calm photo, so no shade is needed (1,332 likes, 6x). Credential-only brand reels ('GOTS certified organic, PFAS free...') sit at about 0.65x likes.
- @wearpepper: Owns its niche in the first person: small-bust women ('Being told to wear a training bra when you're a grown woman with small boobs... a canon event': 27.7K views, 2.9x). Its 'kinda chic to ___' carousel (DcRh4fgGY_d, 56 comments, 14x median) keeps one face at one size on all 5 slides and escalates to a relatable close. It shows how to be typographically consistent without a single box. Kindly's equivalent niche line is its size range at an everyday price.
- @shapermint: A contrast, not a template: shapewear is Kindly's documented anti-audience. Creator first-person reels (#ad 'my most-worn essentials', 227K views, 29x; 'Who says we can't still look HOT... over 40?!') beat the brand's own feature copy ('This is what bra innovation looks like', 0.19-0.59x views). Its pinned creator statement 'At 64, I'm happier and more at ease in my own skin' has 372K views (47x).

**Best content**

- @oeak_official https://www.instagram.com/p/DcL4n-dCHCR/: It uses the same pink template as its weak twin DdT-9TsDXRT, with three differences: the headline is a question ('Which team are you on?'), it shows 4 lettered product cut-outs instead of 8 tiny-labelled pairings, and the caption says 'Comment your team'. Result: 118 likes and 25 comments, against 7 and 0 for the twin. The design is one rounded sans, a pill headline, and the wordmark centred at about 6% of frame height. This is the template for a Kindly 'which one's your everyday' card.
- @oeak_official https://www.instagram.com/p/DbtGBGLHxXg/: A bare mannequin cover with the wordmark small at bottom centre. The caption names one product ('full coverage jelly bra'), offers BUY 1 GET 1 FREE and says 'Comment "Link" and we'll DM you the link'. It reached 23,329 views (8.5x the reel median) with 140 comments on 95 likes. The caption did the work, not the photography, and that is exactly Kindly's gap: 0 asks in 36 posts.
- @meundies https://www.instagram.com/p/Db4CWrfEqb1/: A 4-slide giveaway. Slide 1 is the only graphic ('GAME. SET. ENTER' with ticket illustrations); slides 2-4 are wordless product shots on bodies. Entry is like + tag 2 friends + follow. It drew 250 likes (2.4x) and 297 comments. The same print two days later without the mechanic (Db83ZVEgb_K) drew 54 likes and 4 comments. This is the template for Kindly's Amazon go-live giveaway.
- @meundies https://www.instagram.com/p/Dbq1-ZKgUDS/: The National Underwear Day (Aug 5) card: black ground, one condensed display face at two sizes, wordmark top-centre, one product cut-out, and the ask printed on the card ('Drop the print you'd love to see us make next'). It drew 77 comments against a median of 4, from a dated moment plus a finite, easy question. Its 57 likes sat below median, so use this format to start conversation, not to chase reach.
- @knix https://www.instagram.com/p/DdE9EQBGP5M/: 'Tell us your bra problem, and we'll tell you which style to try.' One serif at one size on a cream ground, wordmark bottom-centre, and a caption that promises a reply in the comments: 67 comments. For a size-inclusive, wire-free brand this is the fit-help format to copy almost as-is, with Kindly's own styles as the answers.
- @knix https://www.instagram.com/p/DdenHg7E4r1/: A 3-slide question of the day. One sentence is split across two identical cards to force a swipe, then the post closes on a real whiteboard photo with a hand tally of the team's answers. It drew 107 comments (3.8x median). It shows how to close a question post without a text box: proof that someone reads the replies.
- @honeylove https://www.instagram.com/p/DcwJkbClLtl/: No text on the cover: the model in the product at a warm location. The caption names the product and the moment ('NEW CloudShape Bra... available now for pre-order') and asks 'Comment "SHAPE" for the link'. It reached 144,153 views (4.6x) and 2,357 likes (16.9x). This is the reach-verified version of the DM funnel for a launch, and the right pattern for Kindly's per-style Amazon go-live posts.
- @aerie https://www.instagram.com/p/DPluyO-EdaY/: A pinned brand pledge from October 2025: real people, no retouching, no AI-generated bodies (#NotAI #NoAI). It has 45,841 likes, 19x the account median, and is the most-liked post in the scrape. In size-inclusive intimates, visibly real bodies are the trust signal, and an AI-looking image works against the category's strongest promise.
- @aerie https://www.instagram.com/p/DdRbJowRzwC/: A pure-graphic brand game: 'which one is aerie green?' handwritten on notebook paper, 8 numbered swatches each carrying the wordmark, with the answer teased elsewhere. It drew 23,106 likes (9.7x) and 1,326 comments without a single product photo. Kindly can run the same idea with its own Sage (#A0C9C3) or Coral (#F2805F).
- @aerie https://www.instagram.com/p/DdR88ujj6p7/: A creator #AeriePartner carousel: 10 wordless slides following a weekend arc from a grass field to an airport mirror. Two recurring prints keep the product in view without it looking like a catalog. It drew 14,914 likes (6.2x). This is the structure for Kindly creator posts: real life, the product worn at the high points, words only in the caption.
- @tomboyx https://www.instagram.com/p/Dcy-p_WAYK-/: Joke, reveal, shop. Slide 1 is a meme card in one caps face; slide 2 is the print full-bleed and text-free; slides 3-4 are numbered 1-6 grids naming every piece on a solid colour ground. It drew 11,765 likes (14x). The numbered grid is the missing graphic close for Kindly: the 4 Wave 1 styles with their size ranges. Keep Kindly's humour gentle, since its voice rules ban jokes about bodies or sizes.
- @pact https://www.instagram.com/p/DdOXZkhRGbA/: The text sits on the empty wall of a calm photo, not over detail: 'GIVEAWAY' in a condensed sans, the circular GOTS seal and the serif wordmark. No shade is needed because the placement solves the contrast, and a seal carries the certification instead of a paragraph. It drew 1,332 likes (6x) and 8,583 comments. This is the model for a Kindly USDA-badge post (an Amber circle with the exact claim phrase).
- @wearpepper https://www.instagram.com/p/DcRh4fgGY_d/: 'kinda chic to ___' across 5 slides: one face, one size, 1-3 words per line, the same position every time. Only the photo and the blank change, and the series escalates to a relatable close ('just wear a bra around the house'). It drew 56 comments (14x median). This is how to be consistent on type without a box.
- @teamkindly https://www.instagram.com/p/DaBOB4UR7dj/: The client's own reach winner, even though the comment ranking calls it 'worst'. It is a 6-second 'perfect summer day' checklist reel in native caption text ('8 hours of sleep / comfiest bra & undies on / iced coffee in hand...'). It reached 2,937 views, 10x the 294 reel median, and got 0 comments because it asked nothing. A second use of the formula (Db02UwFRupq) reached 1,715 views (5.8x); a third near-copy on 2026-08-29 fell to 239 (0.8x). Keep the format, show the product, add an ask, and don't run it a third time.
- @shapermint https://www.instagram.com/p/Dda2dakMnw1/: A pinned creator ad: 'At 64, I'm happier and more at ease in my own skin than ever... Shapewear shouldn't be about changing who you are.' It has 371,921 views, 47x the reel median. It is a first-person body-acceptance line from a real person, not brand copy. Borrow only the voice: shapewear framing is off-limits for Kindly.

**Patterns**

- [high] (hook) An explicit comment ask is the most consistent performance lever in the category, and Kindly never uses it. Evidence: Across 421 non-pinned posts on the 12 accounts, posts whose caption asks for a comment (comment/tag/drop/vote/which one) average the 67th percentile of their own account against the 47th without (n=57). They rank higher in all 9 accounts testable. On reels, where views don't depend on comment counts, they sit at the 60th vs the 48th view percentile (n=40). The vision tags agree: a comment prompt is on 34.8% of best vs 6.1% of weakest (lift 4.8). @teamkindly has 0 asks in 36 posts and 1 question mark.
- [high] (hook) Giveaways are the biggest outliers, but only big-prize, tag-a-friend giveaways lift real reach; small vote giveaways don't. Evidence: MeUndies Db4CWrfEqb1: 250 likes (2.4x) and 297 comments, against 54 likes and 4 comments for the same print two days later without the giveaway (Db83ZVEgb_K). Aerie DdZHZwAEVXW ($500 wardrobe): 12,460 likes (5.2x) and 9,855 comments. Pact DbvtldfRSYw: 5,030 likes (22.8x) and 119.5K views (3.0x). Knix DdHq1ZPD37h: 4,191 comments. OEAK's $50 vote giveaways: 0.9-1.6x likes and 0.6-1.7x views.
- [medium] (hook) A keyword DM ask on a named product lifts reach, but any repeated hook or ask wears out within weeks. Evidence: Honeylove's 15 'Comment LIFT/SHAPE for the link' reels run at a median of about 1.5x reel views (CloudShape DcwJkbClLtl 4.6x). OEAK's 'Comment "Link"' reels were at 8.5x (Aug 6) and 2.1x (Jul 31), then fell to 0.5-0.8x in September once the ask ran on nearly every post; W5 ('Comment Shop') got 0 comments. The same decay shows on @teamkindly: the 'perfect day + set' reel went 2,937, then 1,715, then 239 views across three uses. Keyword posts average the 66th vs 49th percentile (n=32, higher in all 3 accounts testable).
- [high] (language) Creator first-person voice beats brand-voice copy, and Collab posts carry it further. Evidence: Collab or paid-partnership posts average the 68th vs 48th percentile within their account (n=39, higher in 4 of 5 accounts) and the 61st vs 48th reel-view percentile. Shapermint creator reels reach 9.7K-227K views, while its brand feature posts ('This is what bra innovation looks like', 'See why women everywhere are making the switch') sit at 0.19-0.59x. Aerie's creator carousels get about 6x median likes against 0.17-0.28x for its own joke reels. @teamkindly has 0 collab posts in 36.
- [medium] (language) Lines that win are concrete and personal; generic declarative brand statements lose, and they are what reads as AI. Evidence: Tags: complete declarative sentences on 34.8% of weakest vs 21.2% of best; a mixed fragment + question on 28.8% vs 10.6%; an emotional/personal register on 12.1% vs 6.1%. Weak lines, verbatim: 'Comfort starts with the right foundation' (Shapermint, 0.43x), 'The right bra changes everything' (OEAK, 7 likes), 'In our ideal world, it's always golden hour.' (Pepper, 0 comments), 'We still can't get over Navy.' (Harper Wilde, 0 comments). Winning lines: 'Being told to wear a training bra when you're a grown woman with small boobs... a canon event.' (Pepper, 2.9x views) and 'Tell us your bra problem, and we'll tell you which style to try.' (Knix, 67 comments).
- [medium] (layout) Words go on slide 1 only; product slides stay wordless. Evidence: The 20 best-carousel interior slides carry a median of 0 words, and cover words are a median of 0 on both best and weakest posts (n=66 each). Every captured winning carousel follows this: MeUndies B1/B3, Aerie B1/B3/B4 (8-10 slides, no text after the cover), Harper Wilde B1/B3/B4 and Pact B3. TomboyX B1 adds words back only on its closing product-name grid. There is no weak-side interior sample, so this is the category norm rather than a proven differentiator. Our post carries about 330 words across 8 slides.
- [medium] (font sizes) Designed cards use one typeface at one or two sizes, plus the wordmark. Evidence: Knix question and fit cards: one serif at one size plus the 'knix' wordmark (107 and 67 comments). Pepper 'kinda chic to ___': one face at one size across 5 slides (56 comments). MeUndies 'TELL US WHAT PRINT...': one condensed face in 2 sizes (77 comments). OEAK quiz: one rounded sans plus the wordmark. Tags: 2 text sizes on 12.1% of best vs 6.1% of weakest; 3 sizes on 9.1% vs 4.5%; serif display on 10.6% vs 0% (n=7, a small sample). Our post measured 7 size tiers, from 9.7% of frame height down to 1.1%.
- [medium] (graphics) Graphics win when they are a choice or a shoppable grid built from real product cut-outs; spec-sheet infographics lose. Evidence: OEAK, same template: a question with 4 lettered cut-outs and an ask got 118 likes and 25 comments; 8 cut-outs with tiny labels and no ask got 7 and 0. Aerie's 8-swatch colour game got 23,106 likes (9.7x). MeUndies' one-cut-out question card got 77 comments. TomboyX's numbered 1-6 grids closed its 14x post. Among the weak: Shapermint's dotted-line feature infographic (W5, 0.61x) and OEAK's static 'How to keep white bras white' (W3, 0.33x). Boxes/cards appear on 9.1% of best vs 4.5% of weakest, but only as a single device (a pill, a ticket), never as text containers.
- [medium] (design) On photos, text is either one short line on the clean part of the frame or sits over a deliberate shade. Evidence: @teamkindly's best covers carry one native caption line of 4-13 words ('the comfiest summer undies', 'Try on my new bra with me!'). Pact's giveaway places its headline and seal on the empty wall (6x likes). Shapermint B2 washes the selfie out under its serif text. Tags: high text contrast on 31.8% of best vs 18.2% of weakest (lift 1.69). A full-bleed photo with an overlaid headline is roughly even (19.7% vs 15.2%), so the headline itself isn't the problem; contrast and length are.
- [medium] (design) Logos sit in one fixed spot at a modest size, or not at all on plain product photography. Evidence: Knix: wordmark bottom-centre on every card. OEAK: centred top at about 6% of frame height on graphics, about 3% bottom-centre on photos. MeUndies: top-centre on graphic covers only. TomboyX: a small bottom-centre watermark. Honeylove (0 of 12 covers), Aerie and Harper Wilde stamp nothing on photography. Tags: a centred logo on 9.1% of best vs 4.5% of weakest. Kindly's own kit requires a colour backing field whenever the wordmark sits on photography, with a 32px minimum.
- [medium] (imagery) Real bodies, no retouching and no AI are the category's trust signal, and brands pin body-acceptance statements. Evidence: Aerie's pinned #NotAI #NoAI carousel (DPluyO-EdaY) has 45,841 likes, 19x its median and the most of any post in the scrape; its 'No AI-generated people or bodies' reel has 173.6K views. Shapermint pinned 'At 64, I'm happier... in my own skin' (371.9K views, 47x); Pepper pinned 'You didn't need fixing. Just a better fit.' (72K views, 7.5x). Pinning adds exposure, but brands pin their proven winners. Tags: scene-only photos (no product, no person) are on 21.2% of weakest vs 10.6% of best.
- [medium] (hook) Humour, stories and dated cultural moments beat plain product promo, as long as the product shows within one swipe. Evidence: TomboyX's 'two bats' meme, then print, then numbered grid got 11,765 likes (14x); Fat Bear Week + Bisexual Awareness Week got 5,998 (7.2x). MeUndies' best posts ride the US Open, National Underwear Day and a Marvel drop, while all six of its weak posts are plain product promo. Tags: hook 'none' on 0% of best vs 15.2% of weakest; story/narrative on 18.2% vs 6.1% (lift 2.6); humour/meme on 9.1% vs 6.1%.
- [medium] (format) Format alone doesn't predict performance; the mechanic and the voice do. Evidence: Within-account mean percentile: reels 0.49 (n=206), carousels 0.51 (n=169), single images 0.49 (n=46). Tags: format=image on 13.6% of best vs 10.6% of weakest. On @teamkindly, reels in the same format span 96 to 2,937 views; length and the ask decide it, not reel vs carousel.
- [medium] (format) On @teamkindly, reach comes from very short relatable reels, not long try-ons. Evidence: The top 7 reels by views are all 14.3 s or shorter (2,937 / 1,715 / 811 / 794 / 791 / 567 / 566 views, against a 294 median). All five reels of 28 s or longer, including the 72.6 s 't-shirt test' try-on, sit at 257-308 views (0.87-1.05x). The account's median reel runs 8.5 s, against 10.6-31.7 s for competitors.
- [high] (language) Kindly's feed hides every one of its differentiators. Evidence: Across 36 captions: size range 0 mentions (the lab voice guide makes 'XS to XXXL' headline material), sugarcane/plant cup 2, recycled/sustainable 1, price 1, against 'comfy/soft' 12 and 'matching set' 12. The 12 sampled covers show one slim body type, while the lab's audience research says S-M-only imagery is a click-away signal for 3 of 5 high-weight personas. Pact (GOTS) and Aerie (#AerieREAL) build their feeds on their proof point.
- [high] (other) Hidden likes corrupt the best/worst split, and for Kindly the comment ranking and the reach ranking disagree. Evidence: 6 of 12 accounts hide likes on most posts (@teamkindly and Harper Wilde on all 36), and the scraper records hidden likes as 3. So 39 of the 66 'weakest' competitor posts are placeholders, against 18 of the 66 'best'. The worst buckets of Honeylove, TomboyX and Felina are 100% hidden-like, and MeUndies' '25x' B4-vs-W1 gap rests on W1's hidden likes. On @teamkindly, comments correlate 0.18 (Spearman) with reel views, and 'worst' W5 is the reach leader (2,937 views, 10x). Only OEAK, Pact, Shapermint, MeUndies and Aerie give clean contrasts. Two more artifacts: media_count=12 and is_in_profile_grid=false appear on every account. And the 'kindly' wordmark is a custom display serif per the kit, not the 'plain sans-serif' the per-account analysis described.

**Our post against these patterns**

- Wrong business: the post sells wedding and gift personalization, not intimates. → Stop generating for this client until the record matches the lab profile. Run FIRESTORE_DATABASE_ID=prep npx tsx scripts/import-lab-client.ts kindlyyours as a dry run, then with --apply, passing --category for intimates/apparel (without it the category falls back to 'Technology news & media'). The importer keeps existing brandingGuidelines fields and skips context-doc types that already exist, so three steps are manual. (1) Overwrite fontHeading and fontBody, which context-doc-projection.ts:233 sends to the engine, plus toneKeywords, visualStyle and the gifting guidelines text. (2) Delete any gifting context docs. (3) Set the website to walmart.com/kindlyyours or leave it blank. The topic must be Kindly's styles, fit and comfort.
- Too AI-picture heavy: unrelated stock and AI-looking images, zero Kindly product, zero bodies. → Use only real Kindly photography: the client's Wave 1 Drive shoots, @teamkindly content, permissioned UGC, and flat lays of the actual styles. Show two body sizes whenever a body appears. No AI-generated people or bodies and no stock. When no suitable photo exists, build a graphic from product cut-outs instead of generating an image.
- Fonts are not the client's. → Use GT Walsheim once the client shares the licence (ask Lauren). Until then, use the kit's substitute: Fraunces for headlines, Nunito for support. Two families maximum, normal or slightly positive tracking, no mono on social. Never re-typeset the wordmark.
- Text sizes swing between huge and tiny. → Use a two-step scale: a headline at about 5-7% of frame height and one support size at about 3-3.5%. Nothing smaller than 3%, and the same headline size on every slide of a carousel.
- Sentences are open-ended and read like AI. → Write in Kindly's documented voice, 'a friend who knows fabrics': second person, feel first, fabric second, certificate third. Every line is a closed statement about a product truth, or a question with finite answers. Examples in the gated voice: 'The straps cross behind your back, so the band stays put.' / 'Lined in recycled mesh, so the lace never touches your skin.' / 'Naturally soft pure modal. XS to XXXL.' Ban 'not X, but Y' constructions and em dashes.
- Boxes and colours don't look like Kindly's design language. → Remove every text box. Put headlines on a flat Linen, Sage or Deep Sea ground, or on a DNA-dot shape behind the text. Use Coral once per slide as the single emphasis, and Amber #DCA227 only as the USDA badge circle.
- No logo at all, the other side of the owner's 'badly sized/placed' complaint. → Place the kit SVG byte for byte in one fixed spot: bottom-centre on the cover and the last slide. Size it at about 3-4% of frame height on photo slides (white wordmark on a Sage or Deep Sea dot) and 5-6% on graphic cards. Never put it on busy photography without a colour field, and never set it as live text.
- Photo covers carry too much text without a shade. → On photo slides, use 8 words or fewer in one or two lines, on the clean part of the frame. If that area is busy, put a Deep Sea or Sage dot or arc behind the text, or a 40-50% dark gradient, and set the text in white. Body copy never goes on a photo; it goes in the caption.
- Slides repeat. → Add a pre-publish dedupe gate: hash every slide and reject near-duplicate images or any repeated headline. Never render truncated text. Every slide must add one new product, angle, body or fact, or be cut.
- Too text-heavy. → Slide 1 gets 10 words or fewer. Interior product slides get 0 words, or a 1-3 word style name tag. The final slide is a numbered style grid or the ask. The explanation, value math, care line and claims go in the caption.
- Not enough graphics; the only 'graphics' are text containers and a stat. → Build a recurring graphic set from Kindly product cut-outs on brand grounds. (a) 'Which one's your everyday?': the 4 Wave 1 styles lettered A-D on Sage dots, captioned 'comment your letter'. (b) A fit card on Deep Sea: 'Tell us your bra problem. We'll match you a Kindly style.' (c) A size-run slide: the same style on an XS-M and an XL-3X body, labelled with the real range. (d) A closing numbered style grid with names and sizes. (e) The Amber USDA badge, on 40050 posts only.
- Wrong CTA and no conversation mechanic. → End every post with one on-brand ask, rotated so no ask repeats in consecutive posts: 'Comment COMFY and we'll DM you the link' (on a named style, for the Amazon launch), 'Which one's your everyday? A, B, C or D', 'Tell us your bra problem', 'Tag someone who needs comfier basics', or 'Save this for your next drawer refresh'. Caption shape: a hook line with the size range, 2-3 short lines going feel, then fabric, then proof, then the ask, then #livekindly #TeamKindly. Amazon-launch posts never name Walmart (drop #onlyatwalmart), and no price or star-rating callouts go on the image.
- Facts come from the wrong world and can't be substantiated for this client. → Take every on-image fact from the lab claims truth table (brand-voice section 6) or from real review quotes in target-audience section 6 (for example 'So comfortable... you forget you're even wearing them'). No third-party stats unless they're about intimates and cited in the caption.

**Client rules (L3)**

- Kindly Yours is @teamkindly: size-inclusive, sustainable everyday bras, bralettes and underwear from Rafar Group. It has been Walmart-exclusive since August 2021 ($11-$23, about 3,000 stores) and is launching on Amazon US. Never produce gifting, wedding, personalization or consultation content. The brand source of truth is karos-agents/clients/kindlyyours (profile/, brand/kit/, brand/logos/). Never use kindlyyours.com (a parked for-sale domain) or thisiskindly.com (HTTP 402 'Store unavailable' on 2026-09-24) as a source for brand, fonts or links.
- Gate the agent on the record: no post ships until the portal client carries the lab profile, the real logo, the kit fonts and the Kindly palette. The generated gifting fontHeading/fontBody, toneKeywords, visualStyle and guidelines text must be overwritten by hand, because the lab importer keeps them.
- Type: GT Walsheim if the client licenses it; otherwise the kit's render stack, Fraunces for headlines and Nunito for support. At most 2 families and 2 sizes per slide: headline about 5-7% of frame height, support about 3-3.5%, nothing under 3%. Keep the headline size the same on every slide, with normal tracking, sentence case and no monospace. The 'live kindly' wordmark is artwork only and is never typeset.
- Colour: Ink #231F20 for text, never pure black. Grounds are Linen #F6ECE4, Sand #FAF8F0, Sage #A0C9C3, Blush #F9CFC8 or Deep Sea #376A6C. Coral #F2805F appears exactly once per slide as the emphasis. Amber #DCA227 appears only on the USDA badge. No tan/gold #d4a574 and no gradients.
- Graphic language is circles, not boxes: the Coral-left/Sage-right Overlap; single-colour DNA dots from the kit's dots/ folder as crop masks, badges and text backers; and one Full Bleed arc as a background. No rectangular text cards, drop shadows or outlines.
- Logo: the kit SVG byte for byte (logo-dark.svg on light grounds, logo-light.svg on photos and dark grounds), in one fixed spot at bottom-centre on the cover and the last slide. Size it at about 3-4% of frame height on photos, always over a colour field, and 5-6% on cards. Minimum 32px, with clear space equal to the cap-height of the 'k'.
- Imagery: real Kindly product only (the client's Wave 1 shoots, @teamkindly content, permissioned UGC, flat lays). Whenever a body is shown, show at least two sizes, one XS-M and one XL-3X; today every sampled cover shows the same slim build. Use warm natural light and everyday moments (coffee, couch, getting dressed). Never seduction-coded, never stock, never AI-generated people or bodies.
- Every post carries one proof point on the image or in the first caption line, in this order of priority. (1) The size range, stated exactly: bras and the bralette 'S to XXXL', modal underwear 'XS to XXXL'. (2) A felt benefit in customer words ('stays put', 'no dig', 'forget you're wearing it'). (3) 'Pure modal'. (4) 'USDA-certified plant-based foam cup', exact phrase, only for the 40050 So Comfy! Cross-Over Hybrid Bra. Today 0 of 36 captions state the size range.
- Claims gates from lab brand-voice section 6: never name Braskem. No 'stays in place' or 'won't slip' for the 22029/22030 waistbands. Boyshort anti-ride-up only by virtue of full coverage. The lace bralette is comfortable because of its recycled-mesh lining, not because the lace is soft. No OEKO-TEX or Lenzing claims and no durability promises. Banned words: seamless, shapewear, compression, sculpting, elevate, indulge, luxurious, sexy, guilt-free, game-changer, and a bare 'eco-friendly' or 'green'. Always write 'So Comfy!' with its exclamation mark.
- Channel: posts tied to the Amazon launch never mention Walmart and never compare prices across channels. No price or star-rating callouts on the image; value math such as 'about $5 a pair' goes in the caption. Check with the client before any post names Walmart.
- Voice: 'a friend who knows fabrics'. Write lowercase-casual captions like the account's own ('the t-shirt test never lies'), in the second person. Each line is a closed statement or a finite question, at most 12 words on an image line. No 'not X, it's Y' aphorisms, no em dashes, sparing warm emoji. Gentle humour is fine; never joke about bodies or sizes.
- Mechanics: every post ends on one ask, rotated so the same ask never runs twice in a row. The options: a keyword DM on a named style ('Comment COMFY for the link', at most once a week); a lettered A-D 'which one's your everyday' card; the fit-match card ('Tell us your bra problem, we'll match you a style'); 'Tag someone who needs comfier basics'; or 'Save this for your next drawer refresh'. For the Amazon go-live, run one tag-a-friend giveaway with a real prize, such as a full Wave 1 set for the winner and a friend.
- Reels: 6-15 seconds, with the product or the feeling in the first second and one native-style caption line. The account's reach came from 5-6 second relatable reels (2,937 and 1,715 views against a 294 median), while every reel of 28 seconds or more sat at or below median. Reuse a winning formula at most twice: the third 'perfect day + set' reel got 239 views.
- Carousels: 4-7 slides. Slide 1 carries the only headline (10 words or fewer) and the wordmark. Interior slides are wordless, each a new angle, body or style. The last slide is a numbered style grid (the Wave 1 names and size ranges on a Sage ground) or the ask card. No two slides alike and no truncated text.
- Creators: publish creator and try-on content as Instagram Collab posts, in the creator's first-person voice. Kindly has 0 collabs in 36 posts, while collab posts rank about 20 percentile points higher in 4 of 5 competitor accounts. Keep crediting the model by name, as the account already does ('Vienna wears...').
- Measurement and cadence: likes are hidden on all 36 posts, so judge reels by views against the 294 median, and carousels by comments, saves and shares from Insights (ask the client for access). Ignore the comment-based best/worst split, which correlates only 0.18 with reach. Resume at 3-4 posts a week, weighted to the Amazon launch: the account has not posted since 2026-08-31, and peers run 2.9-4.2 a week.

**Industry rules (L2)**

- Every intimates post ends with one explicit, answerable ask. Posts with a comment prompt average about 20 percentile points higher inside their own account (in all 9 accounts testable), and their reels also reach further.
- Run giveaways rarely and big. A meaningful prize with a tag-a-friend entry lifted likes 2.4-23x and views about 3x at MeUndies, Aerie and Pact; small $50 vote giveaways did not. Mark each one closed afterwards.
- Use keyword-DM funnels ('Comment LIFT for the link') only on a named product with a fresh reason: a launch, a restock or an offer. Used as a default sign-off they decay within weeks (OEAK went from 8.5x in early August to 0.5-0.8x by September).
- Creator first-person voice beats brand voice. Publish creator work as Collab posts, and treat feature-copy captions ('This is what bra innovation looks like') as the weakest register in the category.
- Show real bodies across the size range. No AI-generated people or bodies, and no retouching claims you can't keep. The most-liked post in this scrape is Aerie's no-AI, no-retouching pledge (45.8K likes), and brands pin their first-person body-acceptance posts.
- Keep words off product slides. The hook goes on slide 1, interior slides stay wordless, and the explanation, value math and claims move into the caption. Winning interior slides carry a median of 0 words.
- Designed cards use one typeface, one or two sizes and the wordmark in one fixed position, and they pose one question with finite answers (A-D, this-or-that, 1-8).
- Graphics must be a choice or a shoppable grid built from real product cut-outs: a team quiz, a colour game, a numbered size-run grid or a 2x2 'types of wearers' chart. Never a spec-sheet infographic. On the same template, question vs statement drew 118 vs 7 likes.
- Text on photos is one short line on the clean part of the frame, or sits on a deliberate shade or colour field. Never a paragraph over a busy photo.
- Logos: plain product photography needs no stamp. Graphic covers carry the wordmark top- or bottom-centre at about 3-6% of frame height, in the same spot every time, on a solid field.
- Hook every post to something: a dated moment (National Underwear Day on Aug 5, the US Open, Halloween, awareness weeks), a question, a joke or a story, with the product visible within one swipe. Having no hook is the most common trait of weak posts (0% of best vs 15% of weakest).
- Humour works when the product pays it off (joke, then print, then grid). In size-inclusive intimates it never targets bodies or sizes.
- Don't choose a format by habit. Reels, carousels and single images rank the same inside accounts (mean percentile 0.49, 0.51, 0.49), so pick the one the mechanic needs, and keep reels short unless the demo needs the time.
- Rotate before a format tires: any repeated hook, template or ask loses reach by its third near-identical use.
- Measure with views, comments, saves and shares, not likes. Half the accounts here hide likes on most posts, and scrapers floor hidden likes at a placeholder, which fills 'worst' lists with artifacts. Rank reels by views, and compare posts within an account, never across accounts.

## Client synthesis: karoslabs

**Best creators**

- @reputeforge: The best carousel craft in the set: 4 of its top 6 posts are carousels (colours-vs-shades x19.18 with 87.6k likes; logo-vs-branding x8.83; Samsung/iPhone Duo comparison x6.97). Each post repeats one module with new content. The proof is always a real brand asset (logos, found print ads, product shots), text runs about 6-16 words a slide, and a single highlighter device does the emphasis, the job Karos's orange block does. What Karos can take: make every interior slide a picture of the point.
- @becauseofmarketing: The closest tonal match to Karos: editorial serif masthead, trend essays, 100% carousels, 332k followers. On covers the image fills about 80% of the frame, with a small 1-2 line serif headline in its darkest third, a fixed 'BoM' mark top-left and no accent colour. Interiors are either wordless or carry one ~20-word caption per slide. Its biggest post (x10.09, 332 comments) is its only illustrated cover: hand-drawn brand illustrations with the brand names lettered into the drawings. Caveat: likes are hidden on all 36 posts, so its ranking uses comments only.
- @thebrandblueprint_: Its Gen Z/minimalism carousel ran x11.03 (7.7k likes, 743 comments). Every slide names a DTC brand and uses one fixed case-card module: principle headline, explainer box, real product photo, and a 'What they did / Why it works' panel. Covers stay within 11-17 words, carry no logo and close on a comment keyword. Its top reel (x28.24) has a hand-drawn cover. It shows dense slides can still win when each one is the same module anchored by a real photo.
- @ericosiu: The closest peer in topic and design. Single Brain's '30 features of an AI-native marketing team' (x4.33, 18 comments) runs a locked system: fixed header with slide counter and progress dots, a 2-line headline with one orange phrase at a constant size, and one diagram or box row per slide. It works as a saveable field guide. His Reel B1 (x43.11) paired a finished deliverable with a comment keyword and drew 213 comments against 137 likes. Caveat: low baseline (median 18 engagement).
- @sintra.ai: A direct AI-employee competitor with an owned visual system: one colour-coded 3D character per agent, plus a 5-slide proof template (name reveal, a real desk photo of the figure next to the live product, two UI chat-card outputs, tagline close) at about 35-45 words in total. 'Meet Soshie' ran x8.26. It proves the product by showing what it produced. Its feature and onboarding posts are its weakest (0.20-0.37x).
- @peoplebrandsandthings: A purely typographic and photographic system: serif on white, with no icons, charts or boxes. Its carousels repeat 3 beats: headline + photo, a near-wordless payoff image (J.Crew's 160-portrait grid), then a quote from a named executive (J.Crew x3.65; Gap x2.9 with 76 comments). Every winner leads with a famous brand or person. Its two self-promotional billboard posts are its worst (0.10x, 0.23x).
- @neilpatel: The largest reel outliers in the set: x71.45 for '37 places AI looks for you' (1,178 comments) and x18.87 for a live Google demo, each a concrete, checkable number plus a comment keyword. He also gives the clearest negative lesson on data covers: his NP Digital 'Marketing 2030 Insights' report cards (78-90 words, 4+ text sizes, charts, no face) are his two weakest posts (0.54x, 0.67x).

**Best content**

- @karoslabs https://www.instagram.com/p/Dba_DXJDS06/: The house reference and the account's top post (x4.67: 11 likes and 1 comment against a median of 3). The 1984 action photo stays bright across the top 60%. A 7-word headline, 'The rookie who asked for [a cut]', sits in the shaded bottom third with the orange italic block and a mono kicker (MICHAEL JORDAN). Each interior slide carries one device: 'A fee → A share' cards with an arrow and an orange outline on the winner; a rule → fine → ad flow; $6.99bn in Spectral with an orange rule, two chips and a Form 10-K source line. It closes on a 2-line maxim. The headline size never changes, and this is the account's only real human face in action.
- @karoslabs https://www.instagram.com/p/Da2X5avjTOY/: The cream 'playbook' system (x3.0). Slide 1 gives away the whole 5-item list on a white card. Every rule slide repeats one grid: an orange index; a headline with one orange italic word, always at ≈5% of frame height and 22% from the top; a 2-3-sentence body; one small device (A/B toggle, headline-vs-body bar chart, 1-of-5 boxes, 1959→1999 timeline); and a dated source. It shows that one module at one scale reads as a series.
- @karoslabs https://www.instagram.com/p/Dar-Vj5DZ3w/: The most-commented post on the account (2 comments, x3.0). Its cover is the sparsest in the grid: 5 words over a shade at the bottom of a Renaissance Kairos painting. Archival art carries the middle slides, a 'too early / the moment / too late' row makes the timing point as a graphic, and the brand thesis is written in first person. It closes on the bespoke line-art Kairos icon and a direct 'say hello at @karoslabs'.
- @reputeforge https://www.instagram.com/p/DdOcP7yoJg-/: x19.18, 87.6k likes. A 2-line typographic hook on near-black: 'You don't love colors, you love shades →'. The next 8 slides repeat one module: a towel stack fading through one hue, the shade names, and real brand logos beside their shade (Heinz, Netflix, Airbnb, Cadbury, Hermès…). The graphic carries the content at about 16 words a slide, and the post cuts to a plain black follow card.
- @reputeforge https://www.instagram.com/p/DdgZtmVID8H/: x8.83. 'This is Logo / This is Branding' repeated for McDonald's, Audi, Nivea, Tabasco and Durex, with a real print ad as the proof each time. About 6 words a slide, one soft highlighter device, cream paper ground. The reader gets the comparison in under a second.
- @reputeforge https://www.instagram.com/p/DdRaITZEgGd/: x6.97, 1,039 comments. A dated side-by-side (Samsung Galaxy Z Fold 8, July 2026; iPhone Duo, September 2026), pegged to live news and framed as a claim people want to argue with.
- @becauseofmarketing https://www.instagram.com/p/DdL3d0nGFLo/: x10.09 (332 comments; likes hidden). The account's only illustrated cover: a crayon Cartier box under a small serif headline and subhead. The interior is hand-drawn brand illustrations with the brand names lettered into the drawings and no narration. A distinctive drawn device did more than any amount of copy would have.
- @thebrandblueprint_ https://www.instagram.com/p/Dcgh7IooCQT/: x11.03, 7.7k likes, 743 comments. A photo cover that stops the scroll, with a huge 6-word headline and a one-line subtitle bar. Then 7 identical case cards, each on one named DTC brand (Touchland, Fishwife, OLIPOP, Graza…) with a real product photo and a 'What they did / Why it works' panel, closing on a comment keyword that unlocks more. The slides are dense, but every one is the same module anchored by a real photo.
- @ericosiu https://www.instagram.com/p/DcwM1cLmgky/: x4.33 (24 likes, 18 comments, on a low baseline). Single Brain's '30 features of an AI-native marketing team' sits in Karos's own category and uses almost the same logic: white/black ground, a 2-line headline with one orange phrase at a constant size, a fixed header with slide counter and progress dots, and one relationship diagram or row of 3-5 labelled boxes per slide. It reads as a reference worth saving.
- @sintra.ai https://www.instagram.com/p/C6_huzxocp2/: x8.26 (537 likes, 102 comments). A 5-slide proof template: a 1-word script name reveal; a real desk photo of the figurine next to the live product; two close-ups, each with a UI chat card showing a real output (an Instagram bio, a May content calendar); and a tagline close. About 40 words across the whole carousel.
- @peoplebrandsandthings https://www.instagram.com/p/Ddl-LUFlmXy/: x3.65. Three beats and no boxes or icons: a serif paragraph over 3 portraits, the first of them Spike Lee; a near-wordless 160-portrait grid as the payoff; and a quote from J.Crew's creative director, named with her title. The image is the proof and the quote supplies the authority.
- @smartsitesnj https://www.instagram.com/p/Db5wR5omqOH/: x11.07 (35 likes, 16 comments). The company's history told only through real photos with year labels (about 3 words a slide), closing on a credential card: Inc. 5000, 10 years in a row. Every point on this timeline is a real event, where ours had two labels marked 'illustrative'.
- @neilpatel https://www.instagram.com/p/DdZdR8Xk8el/: Reel, x71.45, 1,178 comments. A concrete, checkable number ('37 places AI looks for you') over his standard talking-head template, plus a comment-keyword CTA. The same template with vague, number-free lines scores 0.43-0.53x.
- @viralnation https://www.instagram.com/p/DWE8U3GDPZa/: x17.97, 1,608 likes. One hand-gesture photo repeated on 5 flat-colour slides, each with a one-line headline ('social media manager, zoom in.'). Peer humour for marketers at about 5 words a slide.

**Patterns**

- [high] (font sizes) Winning carousels keep one type scale from the first slide to the last. Ours changes it on almost every slide. Evidence: Karos's own Five-rules carousel (x3.0) sets every interior headline at ≈5% of frame height on the same 22% line, and all body text at 1.94% (slides 2-6). @ericosiu's field guide and @reputeforge's colours carousel (x19.18) also repeat one layout at one scale. Covers with a single text size are 19.2% of best vs 10.3% of weakest (lift 1.78). Our Wrapped render uses 8 font sizes (246/139/94/52/32/25/22/15 px on a 1080 canvas), 5 of them on slide 6 alone, and the headline drops from 139px to 94px at slide 7.
- [medium] (design) Editorial accounts that win give each typeface one fixed job, and serif-led or hand-made type over-indexes against plain sans. Evidence: Plain sans-serif covers are 30.8% of best vs 47.4% of weakest (lift 0.66). Handwritten/script type is 9% vs 0% (e.g. sintra's script names, viralnation's 'Dear Marketer' brush script, becauseofmarketing's hand-lettering). Fixed roles: @becauseofmarketing uses a serif masthead, serif headline and sans subhead; the Karos grid uses Spectral for headlines, lists and every big number, Hanken for body, and a mono for eyebrows. Our render sets its display numbers (500M+, 713M) and its list heads in Hanken semibold, uses no Spectral italic at all, and declares IBM Plex Mono, a face in neither the client's kit nor on karoslabs.com (DM Mono).
- [medium] (font sizes) Big cover type wins only when the line is short. A long sentence set huge turns the cover into a wall of text. Evidence: 'Huge' cover headlines are 24.4% of best vs 11.5% of weakest (lift 2.0), while 'large' is 32.1% vs 48.7% (0.67). The huge winners are short: @thebrandblueprint_'s 'How Gen Z Killed Millennial Minimalism' (6 words, x11.03) and Karos's 'The rookie who asked for a cut' (7 words at ≈114px, x4.67). Our cover sets 12 words at 139px over 5 lines, filling 26-76% of the frame's height, and adds an 8-word subhead at 52px.
- [high] (layout) Photo covers that win leave the subject visible and put all the text in a shaded band. The text never crosses the subject. Evidence: Karos's Jordan cover keeps the photo bright through the middle (40th-percentile luminance 46-60) and puts the headline at 63-80% of frame height over a darker band (32-44). The Kairos cover keeps the painting bright in the top half (117-163) and puts a 5-word headline at 77-90% over a shade (31-39). @becauseofmarketing sets a small 1-2 line serif headline in the image's darkest third on all 6 of its best covers. Photo-dominant covers lift 2.08 and medium-contrast covers 0.55. Our cover darkens the whole photo (6-25) and runs the headline across the phone screen, its one bright element (75th percentile 129), where it collides with the screen's own '2023 Wrapped' type.
- [high] (graphics) In the carousels that win, every interior slide carries exactly one graphic, and that graphic makes the point. Evidence: The Karos grid does this on every interior slide: an A/B toggle, a headline-vs-body bar, 1-of-5 boxes and a 1959→1999 timeline (Five rules); fee→share cards with an arrow, a rule→fine→ad flow, and $6.99bn with two chips (Jordan); a 2x2 positioning map and a $700m→$1.4bn pair (Liquid Death); Chronos/Kairos icons, a too early/the moment/too late row and a Kairos→Karos transform (Kairos). Other accounts do the same: @reputeforge puts logos on swatches and uses found ads, @sintra.ai shows UI chat cards, @ericosiu has one diagram or box row per slide, @thebrandblueprint_ pairs a product photo with a What they did/Why it works panel. Across our 8 slides there is one numbered list and one diagram, a 2-label timeline marked 'ILLUSTRATIVE, NOT MEASURED'. The slide titled 'Before and after: the pipeline rebuild' is two ~20-word paragraphs.
- [medium] (graphics) Graphics belong inside the carousel. On the cover they lose. Evidence: Cover tags, share of best vs weakest: icons 9% vs 21.8% (lift 0.44), charts 1.3% vs 5.1% (0.4), screenshots 2.6% vs 7.7% (0.43), big number/stat 3.8% vs 9% (0.5), boxes/cards 24.4% vs 35.9% (0.69). All 6 of @npdigitalglobal's weakest posts are 3D-icon webinar covers. @neilpatel's two chart-heavy 'Marketing 2030' cards are his two lowest multiples (0.54x, 0.67x).
- [high] (imagery) Stock-looking photos are the most negative visual source. The posts that win use specific real imagery or a drawn or character system the brand owns. Evidence: Stock-looking photos are 1.3% of best vs 7.7% of weakest (lift 0.29). @askokara ran the same '$99 CMO' claim twice: x1.33 over a real scenic photo, x0.45 over a stock org-chart graphic. The 'AI-generated-looking' lift of 3.0 comes from @sintra.ai's own 3D mascots, not from generic AI scenes. Karos's 9 posts use only archival or public-domain art (Wikimedia Commons, Library of Congress, Smithsonian, credited) and one plain product shot. Ours uses two generic hand-holding-a-phone photos, and slide 1 shows a 2023 Wrapped screen under a claim about Wrapped 2025.
- [high] (language) Winners write like a person talking, in concrete lines that finish their thought. Negation frames, fragment chains and jargon read as AI. Evidence: Conversational register is 34.6% of best vs 15.4% of weakest (lift 2.15); neutral/informational 7.7% vs 17.9% (0.47); hype 7.7% vs 16.7% (0.5). Winning lines name the thing and finish: 'It sells water by refusing to look like water', 'You don't love colors, you love shades', '160 people, 1 campaign'. Our post uses 'X is not A. It is B.' 4 times, leaves 'Your channels stay silent for the opposite reason.' unresolved, stacks fragments ('Nothing is shared. Nothing compounds.') and uses terms the kit's Don'ts ban (Dataflow, GCP, Bigtable, column families). Root cause: the engine's value-signals gate rejected 'Half a billion shares. No agency brief.' for having 'no number' and twice suggested the template 'X is not the reason Y happens. Z is.' Attempt 3 copied it.
- [medium] (hook) Comparison hooks win when the reader can see both sides at a glance. Evidence: Comparison hooks are 11.5% of best vs 2.6% of weakest (lift 3.33), and every example is visual: @reputeforge's 'This is Logo / This is Branding' (x8.83), Samsung vs iPhone Duo with dates (x6.97) and 'Who copies Apple?' phone grid (x7.26); Karos's 'A fee → A share' cards and '$700m → $1.4bn'. Number/list hooks lift 0.6 and questions 0.67. Our 'comparison-card' slides set one paragraph against another, so the reader has to read both before any contrast shows.
- [high] (hook) A famous, named subject beats an abstract or internal topic in nearly every account. Evidence: The best sets anchor on famous brands, people or events: @reputeforge's Heinz/McDonald's/Apple, @peoplebrandsandthings' J.Crew/Gap/Yankees, @nogood.io's Toys R Us (x82) and Apple event (x49), Karos's Jordan (x4.67). The weak sets skew internal: @nogood.io's 'What I'm Sending to My Team' template run 4 times (0.08-0.30x), @peoplebrandsandthings' own-billboard posts (0.10x, 0.23x), @viralnation's event photos, @sintra.ai's onboarding posts (0.20-0.37x). Spotify Wrapped is a strong subject, but our post leaves the story for an abstract thesis ('unified record', 'the architecture is the campaign').
- [medium] (design) Winners use one brand accent boldly. Muted and dark palettes under-index. Evidence: Brand-colour-heavy covers are 19.2% of best vs 6.4% of weakest (lift 2.67); muted/neutral 16.7% vs 34.6% (0.5); dark 24.4% vs 37.2% (0.67). Karos's accent is a flat orange block behind an italic phrase, on 8 of 9 covers. Our cover has no orange at all. The only accent in the post is a rust-to-grey gradient fill (sampled #4f2d1e to #3a3735) on four panels, which is exactly the dark, muted profile of the weak set.
- [medium] (design) Logos stay small and fixed, or are left off. Evidence: No logo on 69.2% of best covers vs 42.3% of weakest (lift 1.62). Top-left logos are 16.7% vs 34.6%, centred 3.8% vs 10.3%; reels confound this because they rarely carry logos. Accounts that brand every slide use one small fixed lockup: @becauseofmarketing's 'BoM' top-left, @ericosiu's header bar, Karos's icon plus serif wordmark top-left at ≈2.6% of frame height. Ours is an icon-only mark in the top-right, ≈1.6x the client's icon (5.3% vs 3.3% of frame width), sitting in the slot the grid uses for its orange eyebrow.
- [high] (layout) Named series templates are what make an account recognisable: the chrome repeats, the content changes. Evidence: @reputeforge runs 3 templates; @becauseofmarketing 1 masthead with 2 cover grammars; @sintra.ai 1 five-slide shot list; @thebrandblueprint_ 1 case-card module; @ericosiu 1 Single Brain system. Karos's July grid has 6 named series (THE COME-UP, THE PLAYBOOK, THE BREAKDOWN, MARKETING, BY THE NUMBERS, THE CAMPAIGN FILES, THE PEOPLE WHO BUILT MARKETING), carried by a top-right eyebrow and a caption opener. The engine picks a different visual preset for each Karos post: 'bracketed-figure' here (accent 'tint', type scale 'condensed'), 'quiet-rule' on the previous run (accent 'rule', scale 'editorial'). Neither matches the grid.
- [medium] (layout) Repeat the layout; never repeat the content. Evidence: @reputeforge's colours carousel repeats one swatch module 8 times with new brands (x19.18), and @viralnation's zoom-in carousel repeats one hand-gesture module 5 times with a new role each time (x17.97). Repeated content sits in the weak sets: @nogood.io's roundup template run 4 times, @peoplebrandsandthings' twin billboard posts. Our post repeats '500M+ … up 41% year on year' on slides 5 and 8 (truncated on 8), 'Jan–Nov' on 6 and 8, and the 'one record' idea on 2, 5, 7 and 8. The previous Karos run rendered slides 7 and 8 pixel-identical.
- [low] (format) Carousels of 5-10 slides do best; 2-4 and 11+ underperform. Evidence: Across 163 non-pinned carousels in the 13 comparison accounts, 5-7 slides had the best median multiple (1.43x, 31% at ≥2x); 8-10 had 1.01x (25%), 2-4 had 1.00x (23%) and 11+ had 0.98x (16%). Within accounts, 2-4 was the lowest or tied-lowest bucket at @viralnation, @smartsitesnj, @reputeforge and @nogood.io, and 11+ lost to 8-10 at @reputeforge and @thebrandblueprint_. But @reputeforge's 8-10 beat its own 5-7, so the reliable read is only to avoid the extremes. Karos's outliers ran 5, 7 and 7 slides; ours ran 8.
- [medium] (format) Post in the format the audience already consumes. Carousels win on carousel audiences and sink on reel-trained ones. Evidence: Carousels beat their own account's median at @ericosiu (1.80x), @smartsitesnj (1.54x), @peoplebrandsandthings (1.52x), @sintra.ai (1.48x) and @thebrandblueprint_ (1.41x). They sank at @nogood.io (0.37x; 5 of its 6 weakest posts are carousels) and at @orenmeetsworld (0.56x; his two most designed carousels are his two worst posts, 0.19x and 0.22x). @becauseofmarketing (100% carousels) and @reputeforge (78%) get their top outliers from carousels. Karos has posted 9 of 9 as carousels.
- [medium] (other) A specific ask (a comment keyword, or 'save this for X') outperforms link-in-bio and product-promo asks. Evidence: Comment-keyword CTAs sit behind the biggest multiples: @neilpatel B1 (1,178 comments), @thebrandblueprint_ B2 (743), @askokara B1 (3,850), @ericosiu B1 (213 comments vs 137 likes). Link-in-bio/shop CTAs are 10.3% of best vs 17.9% of weakest (0.6); product-promo hooks 1.3% vs 5.1% (0.4). Caveat: engagement is likes + 3×comments, so the metric itself rewards comment mechanics. Karos's only posts with comments are Jordan and Kairos, and Kairos is the one with a direct ask ('say hello at @karoslabs').
- [medium] (language) Karos's long, sourced caption is worth keeping. Across the industry, though, shorter captions over-index and so do stories over feature lists. Evidence: Short captions (<125 characters) are 23.1% of best vs 14.1% of weakest (lift 1.58). 5 of @thebrandblueprint_'s 6 best posts run under 400 characters, while 4 of its 6 worst run over 600 and 3 of those carry partner tags. @sintra.ai's longest captions (1,028 and 753 characters) are feature lists in its weak set. Karos's top post has a 179-word footnoted story ('per the company's own Form 10-K'). Our caption runs one sentence per line, narrates itself ('This carousel breaks down the structural mechanism…') and moves its sources into a vague first comment.
- [high] (other) Karos's own numbers are too thin to rank. Treat what its outliers share as hypotheses, and read some competitor rankings as comments-only. Evidence: Karos has 22 followers and a median post of 3 likes and 0 comments. 6 of 9 posts tie at exactly 1.0x, and the 3 outliers score 9-14 engagement points. The cross-account stats count Karos's B4-B6 in both the best and weakest sets (they are the same posts), which pulls lifts toward 1. Likes are hidden on all 36 @becauseofmarketing posts and on @thebrandblueprint_'s 6 weakest, so those rankings are comments-only. @npdigitalglobal's median engagement is 3, so its 2-4x 'outliers' are 1-3 extra interactions.

**Our post against these patterns**

- The typefaces are assigned to the wrong jobs, even where the families are right. → Keep the Spectral and Hanken families but lock their jobs. Spectral Medium: headlines, list items and every display number. Spectral Medium Italic: only inside the orange block. Hanken Grotesk Regular: body only. Tracked all-caps mono: eyebrows, indices and sources only. Add the mono to the client kit (fontMono: DM Mono) so the renderer stops falling back to IBM Plex Mono. Don't carry the web app's 'numbers are sans' rule onto the grid, where numbers are serif.
- Text sizes swing from huge to tiny across 8 sizes, and the headline runs at twice the grid's size. → Give Karos a fixed scale. Cover headline 90-115px, 2-3 lines. Interior headline 64-72px, at most 2 lines, same size and position (≈13-22% from the top) on every slide. Body 29px. One stat size, 170-250px in Spectral with a short orange rule. Anything meant to be read at least 20px; only source and credit lines may go smaller (14px minimum). At most 5 sizes in the whole carousel. The engine should reject a slide that changes the headline size or adds a sixth size.
- The copy reads like AI: negation frames, fragments, a hook that never pays off, and jargon. → Tell the story the way the grid does: who, when, what they did, what happened and how much, in complete sentences with one fact each. For example, cover 'How Wrapped got [500 million shares]' with the kicker SPOTIFY WRAPPED 2025 and the sub 'In 2019 Spotify moved it from a desktop microsite into Stories inside the app.' (figures as the post sourced them). For Karos, ban negation frames, 2-3-word fragment chains, teasers that never resolve, meta lines about 'this carousel' and technical terms nobody explains. In the engine, remove the 'X is not…' example from the gate message and count spelled-out numbers ('half a billion') as numbers.
- The boxes use a gradient tint that isn't part of the brand. → Pin accentForm to the highlight block for this client and remove all tint and gradient fills. Make cards flat and compact (a label plus one line or one number, never a paragraph) with hairline borders, and outline the card that wins the comparison in orange. Allow at most one orange block per headline.
- The logo is the wrong mark, at the wrong size, in the wrong corner, and it pushes out the series eyebrow. → Use the kit's own lockup file (icon + wordmark) top-left at the grid's size on every slide, with no tile or disc behind it on photos. Restore the orange mono eyebrow top-right: the series name on the cover and a 1-3-word chapter label on each interior slide.
- The photo cover carries too much text, and the shade isn't where the text sits. → On photo covers, leave the subject untouched in the top ~55-60% and run a gradient shade from about 55% down to the bottom. Put everything in the bottom ~40%: a mono kicker naming the subject and date, a headline of 7 words or fewer on 2 lines with one orange italic block, a sub of 20 words or fewer at body size, and the credit line. Never set text across the subject. If the subject fills the frame, use a typographic cover instead.
- Slides repeat facts, numbers and ideas, and one figure is never explained. → Give each slide one new fact. Every number appears once, with a label. The closer is a single line of 12 words or fewer with one orange-boxed phrase, as in Jordan's 'A percentage bets on the work. A fee [rents your name].' or Liquid Death's 'Winning your category's argument is [still their game].' It is never a recap panel. Before rendering, check for duplicate slides (image hash), repeated numbers or sentences, count mismatches, ellipsis truncation, and spec lines that failed to render.
- The post has too much text and too few graphics: each argument is written out in paragraphs. → Each interior slide gets a headline of 10 words or fewer, one graphic from the grid's kit, a body of 25 words or fewer and a dated source line. Rebuild the post as 6 slides on the dark ground, under the eyebrow THE BREAKDOWN, using only the post's own sourced figures: (1) a real Wrapped share-card image with the kicker SPOTIFY WRAPPED; (2) THE MOVE: two cards, 'Before 2019: a desktop microsite' → '2019: Stories inside the app', with 2019 outlined in orange; (3) THE REBUILD: a before → after pair, '5x the data' → 'costs down 25%' (Spotify Engineering, Feb 2020); (4) THE RESULT: '500M+' in Spectral with an orange rule and chips for '+41% year on year' and 'Wrapped 2025' (LBBOnline, Dec 2025); (5) WHAT TO COPY: a 3-step arrow flow, one data row per listener → the year's stories built from it → shared inside the app; (6) the closer, 'Spotify designed the share [before the campaign].' Move the Dataflow/Bigtable detail into the caption.
- The images look like stock or AI, where the grid uses archival and product images. → For Karos, use archival or public-domain art, the subject company's own press or product image (for example the Wrapped share cards, isolated on charcoal like the Liquid Death can), or no photo at all, and credit it. Never use AI-generated scenes or stock lifestyle phones. If no real image fits, carry the cover with type and the orange block, or with the brand's line-art illustration style (the Kairos icon).
- The caption and hashtags have drifted from the house format. → Open with 'The breakdown: Spotify Wrapped.' Follow with 90-180 words in 3-5 paragraphs, story first and lesson last, naming sources inline and crediting the image. Use one CTA from the house set: 'Save this for your next campaign.', 'DM AUDIT…' or 'Say hello at @karoslabs'. Hashtags: #marketing #brandstrategy #advertising #karoslabs, or one of the grid's variants.

**Client rules (L3)**

- Use the July 2026 grid (9 carousels) as the spec and pin one visual system for @karoslabs. No per-post preset rotation: never 'tint', 'glyph', 'bracketed-figure' or 'quiet-rule'. Ground is #1a1a1a for breakdowns, stories and numbers posts; #f2f1ec cream only for numbered 'playbook' lists.
- Lockup: the kit's own file (line-art head + 'Karos Labs' in Spectral), top-left on every slide, ≈2.5% of frame height, left edge ≈7%. Never icon-only, never top-right, and never on a tile or disc over a photo.
- Eyebrow: top-right in #ff6b2c, tracked all-caps mono (the kit mono, DM Mono; never IBM Plex Mono). The cover carries the series name (THE BREAKDOWN, THE COME-UP, THE PLAYBOOK, MARKETING, BY THE NUMBERS, THE CAMPAIGN FILES, THE PEOPLE WHO BUILT MARKETING). Each interior slide carries a 1-3-word chapter label (THE POSITION, THE MECHANISM, THE BREAK, WHAT TO COPY); list posts may use an orange 01-05 index instead.
- Orange means one flat #ff6b2c block behind a 1-3-word phrase set in Spectral Medium Italic with charcoal ink. It is required on the cover and the closer, and allowed at most once per interior headline. Anywhere else, orange appears only as a 1px outline on the winning 'after' card, a short rule under a big number, index digits, source lines, or the chosen option in a 3-option row. No gradients or tints anywhere. Cards are flat #21211f on charcoal, or white on cream, with hairline borders.
- Type jobs: Spectral Medium for headlines, list items and every display number ($6.99bn, 95%, $700m → $1.4bn). Hanken Grotesk Regular for body. Mono only for eyebrows, kickers, indices and sources. On this grid, numbers are always serif.
- Scale on a 1080×1440 canvas. Cover headline: 90-115px, 3-9 words (grid median 6; 7 or fewer on photo covers), 2-3 lines. Interior headline: 64-72px, 2 lines at most (about 11 words), same size and same top-left position on every interior slide. Body: 29px. One stat size: 170-250px Spectral with a short orange rule. Anything meant to be read: 20px minimum; source and credit lines: 14px minimum. At most 5 sizes in a carousel.
- Photo covers: archival or public-domain (Wikimedia Commons, Library of Congress, Smithsonian), press or plain product shots only, credited on the slide and in the caption. Keep the subject bright in the top 55-60%. Put a mono kicker naming subject and date (e.g. MICHAEL JORDAN; 2012 • RED BULL • STRATOS), the headline and a sub of 20 words or fewer in a bottom gradient shade. Never set type across the subject. No stock lifestyle or AI-generated scenes. With no real image, use a typographic cover or the line-art Kairos illustration style.
- Every interior slide runs: header (lockup + eyebrow) → headline top-left → ONE graphic that carries the fact → body of 25 words or fewer → dated source line. Draw the graphic from the grid's kit: two cards with an arrow (old → new, the new one outlined in orange); a before → after number pair; a 3-step arrow flow; a 2x2 positioning map; a numbered list on flat or white cards; a stat with 2 chips; a 3-option row with the middle filled; a dated timeline built from real points; a headline-vs-body bar; a framed archival image; the line-art icon. No decorative furniture. The owner finds the grid's 35-95 words a slide too heavy, so put the depth in the caption.
- Arc: 5-7 slides. Hook (a named subject with tension) → context → mechanism (graphic) → the number → a closer of 12 words or fewer, bottom-left, with one orange-boxed phrase (the Jordan and Liquid Death arc). Each fact, number and sentence appears once. No recap panels, and no stats on the closer.
- Covers name a real subject and land their point inside the headline: 'The rookie who asked for a cut', 'It sells water by refusing to look like water', 'The moment that named us', 'Five rules that never expired'. Story and curiosity covers are fine; none of the account's outliers is a number hook, so don't force a number or a contrast. On list posts, show the whole list on slide 1. Prefer stories about a real person who can be photographed.
- Voice follows the kit: 'a decisive strategist … without wasting a word'. Write complete sentences that say who, what, when and how much, one fact per sentence. Banned: 'X is not A. It is B.' frames; chains of 2-3-word fragments; teasers that never resolve ('for the opposite reason'); meta lines ('This carousel breaks down…'); technical terms nobody explains (Dataflow, Bigtable, 'unified record', 'compounds'). One closing maxim is allowed, and only after the facts.
- Caption: open with the series label ('The breakdown: Spotify Wrapped.'), then 90-180 words in 3-5 paragraphs, never one sentence per line. Name sources inline ('per Bloomberg', 'per the company's own Form 10-K') and add a credit line for every image. Use one CTA from the house set ('Save this for your next campaign.', 'DM AUDIT…', 'Say hello at @karoslabs') and exactly 4 lower-case hashtags that start with #marketing and end with #karoslabs.
- The account is too small to learn from its own multiples: 22 followers, median 3 likes, 6 of 9 posts tied at 1.0x. Tag every post with its series, cover type (face / archival / product / type), whether the payoff is on slide 1, and whether it is written in first person. Compare comments and saves at 7 days before promoting any trait to a rule. The outliers suggest three hypotheses to test: a real person in action (Jordan), the full list on slide 1 (Five rules), and a first-person brand story with a direct hello (Kairos).

**Industry rules (L2)**

- Put each slide's point in a picture: a real brand asset, a product or UI shot, a found ad or a simple diagram, with about 15-25 words of text. The best carousels average a median of 17 words per interior slide. Dense slides win only as one fixed module anchored by a real photo (@thebrandblueprint_'s ≈90-word case cards, x11.03). Paragraphs in boxes lose.
- Use one type scale per carousel: one headline size, one body size and one label size, in the same positions on every slide. Covers with a single text size over-index (lift 1.78). Big cover type works only on short lines of 7 words or fewer; a full sentence set huge becomes a wall.
- Keep graphics off the cover. Icons (lift 0.44), charts (0.4), screenshots (0.43), big-stat covers (0.5) and boxes/cards (0.69) all over-index among weak covers. A cover is one image or one short line, plus at most one device.
- On photo covers, keep the subject visible and set the text in a shaded third, never across the subject. Photo-dominant covers lift 2.08; medium-contrast covers lift only 0.55.
- Use real, specific imagery or a drawn or character system the brand owns. Stock-looking photos lift 0.29. Hand-made marks (illustration, hand-lettering, script) appear on 9% of best covers and 0% of the weakest. The only AI-looking images that won were a mascot cast the brand owns (@sintra.ai), not generic AI scenes.
- Name the subject in the first line: a famous brand, person, number or live event. Internal and self-referential posts are the weakest pillar in almost every account: team link roundups, the account's own billboards, event photos, webinar promos, onboarding how-tos.
- Show comparisons side by side (A vs B, before → after, logo vs branding); comparison hooks lift 3.33. A rhetorical 'X is not A, it is B' line doesn't count: it shows nothing and reads as AI.
- Write the way a person talks. Conversational register lifts 2.15, informational 0.47, hype 0.5. Every sentence should be complete and finish its thought: no fragment chains, no jargon without a plain explanation, no meta lines about the post.
- Use the brand colour boldly in one device (lift 2.67). Muted/neutral palettes (0.5) and dark ones (0.67) under-index.
- Keep the logo small and fixed, or leave it off: 69% of best covers carry none (lift 1.62). Accounts that brand every slide use one small lockup in a fixed place and never move or enlarge it.
- Run a few named, repeatable series templates, and change the content rather than the chrome. Repeating a layout across slides with new content works (@reputeforge x19.18, @viralnation x17.97). Never repeat a fact, a number or a whole slide, and avoid near-duplicate posts, which compete with each other.
- Aim for 5-10 slides; 2-4 and 11+ underperform. Across 163 carousels, 5-7 slides had a median multiple of 1.43x with 31% at ≥2x; 2-4 slides had 1.00x and 11+ had 0.98x.
- Post in the format the audience already watches. Carousels beat the account median on carousel-led audiences (1.41-1.80x) and sink on reel-trained ones (@nogood.io 0.37x, @orenmeetsworld 0.56x). Don't switch to the other format without a test.
- Ask for one specific action: a comment keyword, or 'save this for X'. Comment-keyword CTAs are behind the largest multiples; link-in-bio CTAs (0.6) and product-promo hooks (0.4) under-index. Track comments and saves separately, because the multiple weights comments 3x.
- AI-product accounts should show the output rather than describe the feature: a UI card, a finished deliverable, a before/after. Examples: @sintra.ai's 'Meet [agent]' proof template (x8.26) and @ericosiu's format-library reel (x43.11). Feature lists and onboarding posts are the weakest (@sintra.ai 0.20-0.37x; @neilpatel's Ubersuggest pitches 0.03x).
- When a live news peg exists, use it by name: @nogood.io's Apple event (x49) and Toys R Us (x82), @reputeforge's iPhone Duo (x6.97), @becauseofmarketing's World Cup edition (x3.52). Evergreen comparisons need a fresh angle; @reputeforge's recycled Braun/iPod post managed only 0.28x.

## Client synthesis: thepitchbydeel

**Best creators**

- @a16z: The best carousel craft in the set, and a partner of The Pitch. Every winner centres one subject or one idea, with one short serif line per slide at a single size and a tiny watermark for a logo. Its biggest post (a Roblox archive, 60.5x) has no added type at all. Its 2-slide before/after (SpaceX Raptor, 9.5x) teaches a product lesson in 8 words. 4 of its 6 weakest posts are reels in generic caption boxes, so the house style carries the account, not the topic.
- @speedrun: a16z's accelerator, with the highest median ER in the direct set (1.44%). Five of its six best posts are documentary cohort photos or unscripted moments: Faces of SR007 (17.3x) and Kickoff week in LA (8.2x, with no added text). Its designed founder-quote template carrying generic lines is its weakest (0.17x, 0.31x). In this category, access and real faces beat templates.
- @hultprize: The closest match to The Pitch in format: a global competition with finalists, judges and a $1M prize. 'Meet the 2026 Global Finalists' (4.8x) is a 5-word title card followed by eight identical cards, each a real portrait. Its best reels are Collabs with the founders they feature. Its weakest are five fill-in-the-blank 'thank you to [university]' shoutouts.
- @startupworldcup: The direct rival. Its 150x post is a real photo of the winning team holding the check, with no designed headline, published as a Collab with the winner and the local angel network. The same info-card template wins or loses on the photo alone (Mauritius 2.4x vs Philadelphia 0.5x). Text plates and stock covers are its weakest posts.
- @antlerglobal: The cleanest A/B test for The Pitch's judge-quote reels. For the same podcast episodes, the designed quote card with one complete sentence beat the auto-captioned fragment every time (2.06x to 2.26x vs 0.45x to 0.58x). All six fragment reels drew zero comments.
- @ycombinator: Puts the payoff on slide 1. All 23 carousels are a designed cover plus one bare proof frame. Winners lead with a recognisable name or a one-glance claim in 10 words or fewer (the Alexandr Wang nameplate, 4.3x). Its top post is a plain Paul Graham excerpt with no design (4.5x). Weak posts use the same template, but their hook is hard to read at a glance.
- @join_ef: Puts a person ahead of the portfolio. All six best posts centre one named person or pair, with a one-line claim and a portrait (the Bubble Robotics founders, 119x). Four of the six weakest are portfolio roundups or spotlights written like press releases.
- @founderspodcast: Every top post opens with a proper noun in its first one to three words (Elon Musk, SpaceX, Rockefeller, Nolan), paired with a single trait. None of its weakest covers carries a name. Its aged-book quote card (running header, centred serif quote, italic signature) is the right model for a card quoting a judge.

**Best content**

- @deelpitch https://www.instagram.com/p/DdrG8zuCLWU/: The client's current Pitch School lesson (Lesson 19, v4 kit, 2026-09-24) and the design bar for our lessons. Grounds are Stage #131313 with one Paper slide. Headlines are Inter Regular with one lilac word ('milestone', 'timeline'). Devices: 1px hairline before/after cards with outlined BEFORE/AFTER pills, and numbered rows with outlined pills. One worked example ($2,000,000 against $110,000 monthly burn = 18.2 months) sits in a single Acai 2 card. The glow pill is the cover graphic; the closer has the eclipse ring and a white JOIN THE 2027 WAITLIST pill. Lockup top-right, rail top-left, and no two consecutive slides use the same device. Likes are hidden, so treat it as the design reference, not as a proven performer.
- @deelpitch https://www.instagram.com/p/Ddl95slCO4v/: The client's own event recap in the v4 kit (Singapore regional final). The cover is an archive photo with a dark scrim under a 5-word headline. Then come three photo windows, each with an inset second photo, a dated eyebrow ('11 MAY · AIRWALLEX') and about 20 words. One Paper slide turns the event into advice ('How to use all three rooms'), and the closer is the glow pill with the waitlist pill. Across the set, event recaps show a 2.67 lift.
- @deelpitch https://www.instagram.com/p/DVwPfNZDHVS/: The account's biggest post, 'Inside the Jury: Alex Bouaziz': 520 likes, 33 comments, 17,799 views, 206x the median. The cover names one person and his role in five words, over a professional portrait, with the lockup large and centred. It was a Collab with @alexbouaziz, so it also reached his audience. Launch season and pinning inflate the numbers, but it is the clearest proof on this account that a named person plus co-authoring moves results.
- @deelpitch https://www.instagram.com/p/DdoryTtuVQ0/: The strongest reel on the only real metric the account has: 2,031 views in about a day, 5.7x the reel median of 354. The cover is one complete, counter-intuitive sentence from a named partner ('The stars are the companies, not the venture capitalists'), with the reversing clause in lilac.
- @a16z https://www.instagram.com/p/Db3xmzlCtd9/: 2 slides, 9.5x. 'Make it exist first,' sits over a studio photo of SpaceX's Raptor 1, visibly wrapped in pipes and sensors; 'Make it good later.' sits over the cleaner Raptor 3. One navy serif line per slide and a tiny watermark; the caption does the explaining. The model for any product-strength lesson: a real before/after of a real product in 8 words.
- @a16z https://www.instagram.com/p/DagNhHVColh/: 7 slides, 12.5x. One centred serif line per slide at one size, alternating maroon and cream grounds, and a tiny A16Z mark. Four archetypes lead to a turn ('None of them win by staying in one lane.'), then a payoff, then the thesis. It shows how a text carousel can keep one layout without reading as repetitive: one line, one size, and a build.
- @a16z https://www.instagram.com/p/DcwjRiNiiOz/: 10 slides, 60.5x, the biggest carousel in the set. The Roblox story is told only through archive photos and old screenshots in date order, with no added type, and closes on the founder's own anniversary tweet. At the top end, real archive beats design, and archive is exactly what The Pitch holds from its regional finals.
- @startupworldcup https://www.instagram.com/p/DdZilbukoS9/: The direct rival's biggest post (150x): a real photo of the winning team holding the check, with no designed headline. It was published as a Collab with the winner (4sell.ai) and the local angel network (sabah.angels). The formula is winner, check and co-authoring together.
- @hultprize https://www.instagram.com/p/DcywmfoINKg/: 9 slides, 4.8x. A 5-word gradient title card ('Meet the / 2026 / GLOBAL FINALISTS') is followed by eight identical cards. Each card is a real outdoor portrait with a bottom scrim, a small-caps eyebrow, the startup name set large, and the university and country set small (10 to 13 words). The Pitch can use this format for regional winners or judges.
- @speedrun https://www.instagram.com/p/DbdNvEtlPAw/: 5 slides, 8.2x. A kickoff-week photo diary with zero added text: every word on screen is physically in the scene (the welcome banner, 'SR007' on a projector, a printed dinner menu). It closes on an LA dusk shot. Access and real moments do all the work.
- @antlerglobal https://www.instagram.com/p/DbqLEoGDKxf/: A quote card at 2.26x, against the same episode's auto-captioned fragment reels: Db-51yXjNMb (0.45x) and Db7r6svDEw0 (0.52x). One complete sentence in quotation marks on the branded card beats a caption burned in mid-clause. This is the direct lesson for The Pitch's judge-quote reels.
- @ycombinator https://www.instagram.com/p/DbZPUtcj1Ms/: 2 slides, 4.3x. 'In conversation with / Alexandr Wang / Chief AI Officer, Meta' (about 9 words) on the orange nameplate carries the whole hook. Slide 2 is a bare candid photo as proof, and the CTA lives only in the caption.
- @founderspodcast https://www.instagram.com/p/DWXFEHpinlW/: 2 slides, 6.3x. The cover is 7 words plus a face ('ELON MUSK / Principles for Building a Company'), followed by one dense 11-item reference slide built to be saved. Density works when it is a single slide behind a name hook, not spread across eight slides.

**Patterns**

- [high] (imagery) Real photos of real people and events beat designed plates, stock and AI imagery across the category. Evidence: Cross-account: 'real photo: place/scene' is on 21.8% of best vs 10.3% of weakest (lift 2.0). Full-bleed photo with an overlaid headline: 33.3% vs 19.2% (1.69). AI-looking images: 0 of 78 best vs 4 of 78 weakest. Stock-looking: 0 vs 6. No human face: 24.4% vs 35.9%. Top posts: a16z Roblox archive DcwjRiNiiOz 60.5x, speedrun kickoff diary DbdNvEtlPAw 8.2x, 500global LEAP photo dump Dak9QtJiX1A 4.6x. Bottom: sahilbloom's AI-looking retro illustrations 0.15x to 0.17x, speedrun's 3D character DZ8TqfskuTl 0.34x, startupworldcup's stock handshake DcOkalnKLF6 0.29x.
- [high] (hook) Short covers that deliver the payoff win. Teaser covers that hide it behind the swipe lose. Evidence: Cover words: best median 5 vs weakest median 8 (n=78 each). Examples: a16z Db3xmzlCtd9 'Make it exist first,' (4 words) 9.5x; YC DbZPUtcj1Ms name plus role (about 9 words) 4.3x; hultprize DcywmfoINKg 'Meet the 2026 Global Finalists' 4.8x. sahilbloom's three 8-to-9-slide carousels, with '(EVERYONE NEEDS TO READ THIS)' and a swipe badge, are his three weakest posts (0.15x to 0.17x). His six best are single cards that give the claim at a glance.
- [high] (graphics) Fewer graphic devices win. No device at all is the winning default, and boxes, pills, icons and arrows skew toward weak posts. Evidence: Graphic devices 'none': 62.8% of best vs 32.1% of weakest (lift 1.92). Boxes/cards: 14.1% vs 28.2% (0.52). Pills/badges: 5.1% vs 12.8% (0.45). Icons: 7.7% vs 16.7% (0.5). Arrows/lines: 1.3% vs 5.1% (0.4). Illustration- or graphic-led cover: 1.3% vs 6.4% (0.33). startupworldcup W1 DcvI0T-vgrZ (six competing blocks, icons, 100+ words) scored 0.14x; its B1, with no designed copy, scored 150x.
- [medium] (font sizes) Use three text sizes or fewer per slide. Evidence: 4 or more distinct text sizes appear on 24.4% of weakest vs 14.1% of best (lift 0.6). Covers with no added text: 11.5% vs 5.1% (2.0). a16z DagNhHVColh keeps one size across 7 slides (12.5x). The client's own v4 lesson DdrG8zuCLWU runs about four sizes: headline about 4 to 4.7% of frame height, card text about 1.5 to 2%, plus a small rail, with the 01 to 03 numerals at roughly headline size.
- [medium] (design) Loud display type reads as a template. Restrained type reads as editorial. Evidence: 'Condensed/display sans' is on 25.6% of weakest vs 7.7% of best (lift 0.33). The gap comes mostly from bold all-caps auto-caption styling, on all six of antlerglobal's worst reels and on 500global's podcast clips. a16z (serif only), founderspodcast (one serif family) and the client's own v4 kit (Inter Regular 400, 'no bold headlines, hierarchy by size') all use a light touch.
- [high] (language) A named person, a real figure or a reversed expectation beats generic advice in every account. Evidence: techstars: four of its six weakest posts are unattributed aphorisms (0.36x to 0.51x); its named founder story DdW_KLTm4wK scored 8.4x. speedrun W1 Ddb7_XbGsO- and W3 DczCa9uEtpl put generic lines on its better template (0.17x, 0.31x). founderspodcast: all six best open with a proper noun, none of the six worst do. join_ef: all six best centre a named person. Register: emotional/personal 16.7% of best vs 9% of weakest (1.75), conversational 26.9% vs 17.9% (1.47), neutral/informational 11.5% vs 25.6% (0.48).
- [high] (language) Quote posts need one complete, quotable sentence. Mid-sentence fragments fail. Evidence: antlerglobal same-episode pairs. Alex Konrad: quote card DbqLEoGDKxf 2.26x vs fragments Db-51yXjNMb 0.45x and Db7r6svDEw0 0.52x. Steve Hind: quote card DcOAMrIjVst 2.06x vs fragments DcQ7hwbjUQn 0.52x and DcLByxBDQ7w 0.58x. All six fragment reels drew zero comments and one fifth to one half of the views of the best reels. hultprize W4 and W5 freeze on auto-caption fragments.
- [medium] (hook) Event recaps and behind-the-scenes posts beat announcements. Question and list hooks lean weak. Evidence: Hook types: event recap 9% of best vs 2.6% of weakest (lift 2.67); behind the scenes 6.4% vs 2.6% (2.0); story 17.9% vs 12.8% (1.36); news/announcement 15.4% vs 25.6% (0.62); question 2.6% vs 5.1% (0.6); number/list 2.6% vs 5.1% (0.6). The question and list counts are small (2 vs 4).
- [medium] (layout) Winning carousels do one of three things: finish the idea on slide 1, run a photo sequence with no added text, or give one line per slide that builds to a turn. Evidence: ycombinator: 23 of 23 carousels are a designed cover plus one bare proof frame. a16z Db3xmzlCtd9 is a 2-slide before/after (9.5x). founderspodcast DWXFEHpinlW is a 7-word face hook followed by one dense reference slide (6.3x). a16z DcwjRiNiiOz (60.5x), speedrun DbdNvEtlPAw (8.2x), techstars DdR1myOiaAC (3.2x) and steven DTprXdLDH_T (5.7x) carry no added text. a16z DagNhHVColh runs one line per slide to a turn and a payoff (12.5x). Median words per interior slide among best carousels: 4 (n=17).
- [medium] (format) Repeating an offer, or cutting one interview into several posts, drags every copy down. Evidence: 500global W2, W5 and W6 are the same X-HUB Tokyo flyer across three weeks (0.10x to 0.28x). Its W1, W3 and W4 are three clips of one interview posted within about 24 hours (0.08x to 0.24x). join_ef W1 and W2 reuse one 'portfolio roundup' headline days apart (0.18x, 0.33x). antlerglobal's four worst reels are duplicates from the same episodes.
- [medium] (other) Co-authoring (an Instagram Collab) with the featured founder, winner or partner is the biggest reach lever for program accounts, and The Pitch no longer uses it. Evidence: Non-pinned posts across startupworldcup, hultprize, techstars, speedrun, 500global, join_ef and antlerglobal: Collab posts have a median of 1.38x vs 0.85x for solo posts, and 40% vs 15% reach 2x or more (n=47 vs 185). startupworldcup's 150x post DdZilbukoS9 was co-authored with the winner 4sell.ai and with sabah.angels. hultprize B1, B3 and B4 were co-authored with the founders they feature. 500global's B1 to B5 are all Collabs. @deelpitch's own biggest post, DVwPfNZDHVS (206x, 17,799 views), is a Collab with @alexbouaziz. None of its 33 posts since 2026-08-18 is a Collab or tags anyone.
- [high] (other) The Pitch's own best and worst labels are noise. Likes are hidden, so reel views are the only real signal. Evidence: All 33 non-pinned posts since 2026-08-18 have likes_hidden=true and show 1 to 3 likes. B1 to B3 (2.0x) differ from W1 and W2 (0.33x) by two likes and one comment. The 16 carousels show no views and 2 comments in total. Reel views are real: median 354, range 178 to 2,031 (n=17).
- [low] (hook) On The Pitch's reels, ranked by views, the top performers make a counter-intuitive claim about how venture or company-building works, from a recognisable partner or the Deel CEO. Evidence: Top 4 by views: DdoryTtuVQ0 David Fialkow, 'The stars are the companies, not the venture capitalists', 2,031 views (5.7x the reel median, in about one day); DdEs9rDORlW Marc Andreessen, 'Venture is a protest movement...', 1,533; DdZVo4DOEJB Martin Casado, on frontier models out-raising the app ecosystem, 1,388; DcLyTrvIRJh Alex Bouaziz, 'Acquisitions are the most underrated skill...', 1,380. Bottom 4 (0.5x to 0.8x): Igor Ryabenkiy 178, Max Li's origin anecdote 229, Ken Chenault's maxim 259, Anish Acharya on why a16z backed Deel 270. Every cover, top and bottom, uses the same template and carries the same stray transcript line, so design does not explain the gap. n=17 and post ages differ.
- [high] (design) The client's current design language is the v4 kit, live on the feed since 2026-09-22: a near-black Stage ground, Inter Regular, hairline cards, outlined pills, one lilac card and the client's own gradient art. Evidence: brand.yaml v4 (2026-09-17): grounds #131313 and #FFFBF4; palette #201148, #5938B7, #A98DF6, #ED5E2A, #FEF0D8; Inter only, with 'no bold headlines; hierarchy by size'; 1px hairline cards with 10px radius; four raster graphics (eclipse ring, glow pill, gradient bands, gradient panels); 'never AI imagery'; logo PNG with 'no plate or bubble'. Retired: Bagoss, deep purple #201547, the mic mark. Live posts on it: DdrG8zuCLWU (Lesson 19), Ddl95slCO4v (Singapore), DdmBCAPorls, DdoryTtuVQ0, DdrKfd4IOdz.
- [low] (hook) The Pitch's real outliers were launch-grade creative: one money figure or one named person in 6 words or fewer, professional portraits of recognisable people, and an open application window. Evidence: Pinned reels: DVwPfNZDHVS 'Inside the Jury: Alex Bouaziz' (520 likes, 33 comments, 17,799 views, a Collab); DVJmFtBjBFe '$15,000,000 investment pool' (182 likes, 11,504 views); DU3fFnYDLIS '$15M Opportunity' (148 likes, 9,882 views). All are 60x to 206x the recent median. The comparison is confounded by pinning, launch season and unhidden likes.
- [medium] (language) Save or share prompts beat link-in-bio and comment bait. Evidence: Save/share CTA: 7.7% of best vs 1.3% of weakest (lift 3.5). No CTA: 59% vs 42.3% (1.38). Link in bio: 23.1% vs 43.6% (0.54). Comment prompt: 7.7% vs 12.8% (0.64). a16z's 'Comment ACADEMY' reel DdruMItuwtD scored 0.16x. sahilbloom's six best all end with 'Send this to someone who...'.
- [low] (design) Winners keep the brand mark quiet. No top post in the set stamps a logo on a plate. Evidence: a16z uses a small centred or corner watermark. The best covers of techstars, join_ef and speedrun carry no logo bug, and neither do founderspodcast's reels. 500global's best quote cards carry no 500 branding. The client's v4 lockup sits top-right at about 13% of slide width with no plate (DdrG8zuCLWU). Centred logos appear on 7 best posts and 0 weakest (small n).

**Our post against these patterns**

- The post uses the parent company's retired brand instead of The Pitch's current kit. This is the owner's 'fonts are not the client's' complaint, and the root cause of several others. → Replace the portal branding for thepitchbydeel with v4 and re-project it to the engine. Fonts: Inter, with headlines in Inter Regular 400 and pills and card titles in Inter Medium 500. Colours: #131313, #FFFBF4, #201148, #5938B7, #A98DF6, #ED5E2A, #FEF0D8. Logo: brand/logos/logo-light.png. Add a render check for this client that fails any glyph outside Inter and any ground other than #131313 or #FFFBF4.
- The post invents how The Pitch judges. → Never say what The Pitch or its judges ask, score or credit unless product-information states it or a named judge said it on record. The account's own reels are a sourced bank: Ryan Hoover on learning 'to judge a great business rather than a cool product' (DcagYf-OTwa), and Igor Ryabenkiy on 'AI by itself is not a product' (DdBzaipITYb). Build the product-strength lesson on those named judges, with their headshots.
- Sentences are open-ended and read like AI. → Make every headline a complete statement that gives the answer, and give each slide one concrete, sourced example. For example, 'No manual workaround, no real pain' becomes 'Airwallex started because one supplier payment cost Max Li an extra 5 to 7 percent' (sourced from the account's DdBskhPOblw). Add question headlines, fact-free two-sentence aphorisms and rhetorical triads to the copy gate.
- The cover is an AI-looking image carrying 28 words and no shade. → Use a real archive frame (a founder mid-pitch, a judges' table, a check handover) with a #131313 scrim over the lower 40% and a headline of 8 words or fewer. Alternatively, put the kit's glow pill on Stage, as Lesson 19 does. Block AI and stock imagery for this client.
- Text sizes swing between huge and tiny: six sizes on one slide. → Allow at most three sizes per slide: headline in Inter Regular at about 4.5% of frame height, body or card text at about 2%, rail and pills at about 1%. Step numbers become light '01' labels at headline size, or sit inside the eclipse ring. Allow one big figure per post, and only for a real number.
- Slides repeat. → Plan the sequence by job before writing: hook, real example, worked numbers, before/after, recap, close. Give each slide its own device and never reuse a device within a post. Alternate Stage and Paper at least once. The closer must say something new: the takeaway plus the waitlist pill.
- Too text-heavy, mostly because each slide states one idea three times. → One idea per slide, said once. Use a headline of 10 words or fewer that gives the answer, then either one body sentence of 20 words or fewer or one kit device, never both plus a numeral. Cover: 8 words or fewer, plus an optional one-line sub.
- Not enough graphics: none of the client's graphic elements appear. → Send the four PNGs to the engine as brand assets, either through a graphics field on the projection or as brand-asset uploads. Require exactly one colour element per slide: one kit graphic, screen-blended on Stage, or one archive photo. Put the post's one key number inside the eclipse ring, and use the glow pill on the cover or the closer.
- The boxes are not in the client's design language. → Build every device for this client from those four parts only. Remove versus bars, 'VS' labels, mono tables, timeline squares and glass panels from its template set.
- The logo is the wrong mark, sits on a plate, and is not sized or placed per the kit. → Place logo-light.png (logo-dark.png on Paper) exactly as supplied, top-right at about 13% of slide width, with no plate. Put the rail 'PITCH SCHOOL · LESSON NN' top-left over a 1px hairline. Never render the parent mark.
- The topic sits outside the brand's pillars. → Route every topic through a pillar and a named source. For example: 'What 2026 judges call a strong product', with three judges, one quote each, a headshot and an archive stage frame. Or a verified regional winner's product before/after, built like a16z's Raptor 1 / Raptor 3 post (Db3xmzlCtd9).
- The caption, hashtags and first comment do not follow the house style. → Write 300 to 450 characters in two or three short paragraphs, ending with 'Save this for ...'. Use #thepitchbydeel #startupfounders plus two lowercase topical tags. Post no first comment unless it names a source that can be checked.

**Client rules (L3)**

- Render only with the v4 kit (2026-09-17). Fonts: Inter only, with Regular 400 for headlines and body and Medium 500 for pills and card titles; no bold, no Bagoss, no monospace. Grounds: Stage #131313 or Paper #FFFBF4. Accents: #201148, #5938B7, #A98DF6, #ED5E2A, #FEF0D8, with at most one solid accent per slide. Never use #201547, Cornbread, Blueberry or Seltzer.
- Logo: place brand/logos/logo-light.png on Stage and on photos, and logo-dark.png on Paper, exactly as supplied. Position it top-right at about 13% of slide width, with clear space at least the height of the b in 'by Deel', and no plate, bubble or effect. Never use the parent 'deel.' mark or the retired mic and d. box. A rail sits top-left ('PITCH SCHOOL · LESSON NN' or the event name) over a 1px hairline.
- Colour comes through one element per slide: either one of the four kit graphics (glow pill, eclipse ring, gradient bands, gradient panels; cropped or scaled only, screen-blended on Stage) or one archive photo. No CSS gradients, glass panels, drawn glows or shadows.
- Use at most three text sizes per slide: headline about 4.5% of frame height, body or card text about 2%, rail and pills about 1%. Step numbers are light '01' labels at headline size, or sit in the eclipse ring. Allow one big figure per post, and only for a real number.
- Build devices only from the kit: 1px hairline cards (rgba(255,255,255,0.28) on Stage, 10px radius, transparent), outlined uppercase pills, the rail, and at most one emphasis card per slide (inverted cream, Acai 2 #A98DF6 or a gradient crop). No versus bars, 'VS' labels, mono tables or timeline squares.
- Never use the same device twice in one post, and never put the same layout on two consecutive slides. A lesson of 6 or more slides alternates Stage and Paper at least once. The closer states the takeaway and carries the waitlist pill; it never repeats earlier labels.
- Photos: archive selects or judge headshots only, never AI or stock. Put a Stage-colour scrim under all type on full-bleed photos. A photo cover carries a headline of 8 words or fewer plus at most one short sub line. Inset photos use a 16px-radius window.
- Copy: every headline is a complete statement that gives the answer, in sentence case. No question headlines, no fact-free aphorisms ('You carry it forever', 'That cost never leaves'), and no rhetorical triads; a list is fine when it is the actual content, like the three Singapore rooms. No em or en dashes and no exclamation marks. Each slide names one real thing: a judge, a verified 2026 regional winner, a partner or a real figure. One short imperative closer is fine when it points back to the lesson's concrete content, like Lesson 19's 'Say the number like you mean it.'
- Never state what The Pitch or its judges ask, score or credit unless product-information says so or a named judge said it on record. When quoting a judge, name them on the slide.
- Every topic enters through a pillar (On the Stage, How They Won, Pitch School, By the Numbers) with a named source. Generic startup advice comes in only through a judge's on-record line or a verified winner's story. The founder is the hero; Deel is never the subject.
- Compliance wording: write 'up to $50,000 SAFE' and 'up to a $1,000,000 investment' exactly. Name only verified 2026 regional winners: never Everreach Labs, never Karos Labs, never a global champion. Call city events a 'regional final', never 'the finale'; DdRPrJNCMF2 slides 2 and 3 still read 'NEW YORK · THE FINALE'. Pitches are two minutes.
- CTA between cycles: 'Save this for ...' as the last line of the caption, and on closers the white 'JOIN THE 2027 WAITLIST' pill. Never 'apply', never comment bait.
- Captions: 300 to 450 characters in two or three short paragraphs. Hashtags start with #thepitchbydeel #startupfounders, followed by two lowercase topical tags. No first comment unless it names a source that can be checked.
- Judge and partner quote reels: the cover headline is one complete sentence from the clip, naming the speaker. Trim the stray transcript line under the name and title. Tag the judge and their firm, and offer a Collab to the judge, the partner or the featured winner. Any Collab with @alexbouaziz needs Albert's approval while Alex's personal content is on hold.
- Event carousels follow the Singapore v4 pattern (Ddl95slCO4v): an archive photo cover with a scrim; one dated moment per slide ('11 MAY · AIRWALLEX') in a photo window, with 25 words or fewer; one Paper slide that turns the event into advice; a glow-pill closer with the waitlist pill.
- Measure honestly. Likes on @deelpitch have been hidden since 2026-08-18, so like counts of 1 to 3 are placeholders and this account's best/worst tags are noise. Rank reels by views (median 354). Rank carousels by Insights saves, shares and reach once the account is connected. Never turn placeholder likes into a client rule.

**Industry rules (L2)**

- Lead with a real, named person or a real event photo, never AI or stock imagery. Real place/scene photos: 21.8% of best vs 10.3% of weakest. AI-looking: 0 of 78 best vs 4 of 78 weakest. Stock: 0 vs 6.
- Put the payoff on the cover in about 5 words (a name, a number or a claim), and never hide it behind the swipe. Cover words: best median 5 vs weakest 8. sahilbloom's swipe-gated carousels scored 0.15x to 0.17x.
- Default to no graphic device, and never use more than one per slide. No device: 62.8% of best vs 32.1% of weakest. Lift for boxes/cards 0.52, pills 0.45, icons 0.5, arrows 0.4.
- Use at most three text sizes per slide. 4 or more sizes: 24.4% of weakest vs 14.1% of best.
- A quote post is one complete, quotable sentence with the speaker named, never a mid-sentence transcript fragment. antlerglobal's same-episode quote cards scored 2.06x to 2.26x; the fragment reels scored 0.45x to 0.58x.
- Specific beats generic: a named founder, a real figure or a reversed expectation over an aphorism or advice line. techstars aphorisms scored 0.36x to 0.51x vs 8.4x for a named founder. speedrun's generic quote cards scored 0.17x and 0.31x. founderspodcast's best posts all open with a proper noun.
- Write headlines as statements, not questions or numbered teasers. Question hooks: 2.6% of best vs 5.1% of weakest. Number/list: 2.6% vs 5.1%. The counts are small but agree with the rule above.
- Publish every feature on a founder, winner, judge or partner as an Instagram Collab, and tag them. In program accounts, Collabs have a median of 1.38x vs 0.85x solo, and 40% vs 15% reach 2x or more. startupworldcup's 150x post was co-authored with the winner.
- Show the room: event photo recaps and behind-the-scenes posts beat announcements. Event recap: 9% of best vs 2.6% of weakest. Behind the scenes: 6.4% vs 2.6%. News/announcement: 15.4% vs 25.6%.
- One offer and one interview per week. Never re-post the same program flyer, and never cut one conversation into back-to-back clips. 500global's repeated flyer scored 0.10x to 0.28x and its triple clip 0.08x to 0.24x; join_ef's repeated roundup scored 0.18x and 0.33x.
- A carousel should do one of three things: finish the idea on slide 1 and add a proof frame (ycombinator's 2-slide format), run a photo sequence with no added text (a16z Roblox 60x, speedrun kickoff 8x), or give one line per slide at one size, building to a turn (a16z DagNhHVColh 12x). The best carousels have a median of 4 words per interior slide.
- Close with a save or share prompt, or with nothing; not link-in-bio or comment bait. Save/share: 7.7% of best vs 1.3% of weakest. Link in bio: 23.1% vs 43.6%. a16z's 'Comment ACADEMY' reel scored 0.16x.
- Write in a conversational or personal register, not an informational one. Lift: emotional/personal 1.75, conversational 1.47, neutral/informational 0.48.
- Keep the program's own mark small and off any plate, or let the stage signage carry the brand. Never swap in the parent company's logo. No top post in the set stamps a logo on a plate, and the winning posts of a16z, speedrun, techstars, EF and Founders carry little or no logo.
- Never learn from like counts on accounts with hidden likes. When likes_hidden is true, the counts read 1 to 3 and any ranking built on them is noise. Use views, saves, shares and reach instead.

## research:legibility

```json
{
 "findings": [
  {
   "claim": "This finding sets the conversion from phone to canvas. Instagram serves photos at up to 1,080 px wide. It keeps any aspect ratio between 1.91:1 and 3:4 at original resolution, so 1080x566 to 1080x1440 is untouched, and 1080x1440 is the tallest frame the feed shows. It sizes wider uploads down to 1,080 px. Feed images fill the full screen width. The most common phone widths are 360 to 414 CSS px (StatCounter, Aug 2026: 414 wide 13.6%, 360 wide 9.3%, 390 wide 6.8%, 393 wide 5.3%, 384 wide 4.4%). So one iOS point or Android dp equals about 2.6 to 3.0 canvas px. The image is about 58 to 71 mm wide on the glass, which puts one canvas px at about 0.06 mm.",
   "implication_for_our_agent": "Convert with canvas_px = pt x 2.75, using a 393 pt reference phone, and check the worst case at x 3.0 (a 360 dp phone). The skill renders at 2x (2160x2880), which Instagram will resample. Downsample it yourself to exactly 1080x1440 with a good filter (e.g. Lanczos), then run every legibility and contrast gate on that 1080 file, because that is what viewers get. A 1 px hairline at 1080 scale is decoration only. Any rule or stroke that must be seen should be at least 2 px at 1080 scale.",
   "sources": [
    "https://help.instagram.com/1631821640426723 (Instagram Help Centre, fetched 2026-09-24)",
    "https://gs.statcounter.com/screen-resolution-stats/mobile/worldwide (Aug 2026)",
    "https://en.wikipedia.org/wiki/Instagram (the original 640 px square matched the iPhone display width)",
    "Derived: device specs and pixel maths"
   ],
   "confidence": "high"
  },
  {
   "claim": "Minimum legible size. People read phones closer than paper: 32.2 cm for web pages and 36.2 cm for texts, against 40 cm for print. Typical phone web text measured about 0.8M, which works out to roughly 0.21 degrees of x-height (Bababekova 2011). Reading stays at full speed only when x-height is at least about 0.2 degrees; the fluent range runs from 0.2 to 2 degrees (Legge & Bigelow 2011). On a 6.1-inch phone at 32 cm, 0.2 degrees of x-height equals about 36 px on the 1080 canvas, assuming an x-height of 0.52 em (the same ratio APCA assumes). It is about 40 px on a mini phone or at 36 cm, and about 33 px on a Pro Max. Apple's iOS minimum of 11 pt is about 30 px, and its default Body of 17 pt is about 47 px. Text baked into an image never grows with the viewer's Dynamic Type setting.",
   "implication_for_our_agent": "Add a MIN-TYPE gate that measures computed font size on the rendered DOM, normalised by the font's x-height. Proposed floors: 30 px for any glyph (labels, source lines, all-caps with tracking), 40 px for any sentence the reader is meant to read (36 px only for secondary lines), and 44-48 px as the default body size. As x-height: at least 16 px for labels, 21 px for body, 23-25 px for comfortable body. Scale fonts with a small x-height up by 0.52 divided by their x-height ratio. Auto-fit must cut words, never shrink below the floor. Several live templates currently put text below these floors: story-carousel.html (.eyebrow 18px, .kicker 22px, .body-text 34px, .quote-attr 16px), verdict-ranking.html (.eyebrow 22px, .rank-take 30px, .rank-take.small 26px), study-fact.html (.fact-kicker 22px, .fact-cite 20px, .sup-cite 18px, .sup-text.small 32px). All are under /Users/albertkattan/Code/karos-agents/products/live/instagram-agent/assets/templates/.",
   "sources": [
    "Bababekova et al. 2011, Optom Vis Sci, PMID 21499163 (via Europe PMC)",
    "Legge & Bigelow 2011, J Vision 11(5):8, https://doi.org/10.1167/11.5.8",
    "https://developer.apple.com/design/human-interface-guidelines/typography",
    "https://git.apcacontrast.com/documentation/APCA_in_a_Nutshell.html (x-height 0.52 assumption)",
    "Derived calculation; local templates"
   ],
   "confidence": "medium"
  },
  {
   "claim": "Headline size. The profile grid shows a cover about 130 pt wide on a 393 pt phone, so one canvas px is about 0.12 pt there. A 96 px headline shows at about 11.6 pt, which is iOS's minimum. A 72 px headline shows at about 8.7 pt, and 48 px body at about 5.8 pt. Apple's display sizes convert to about 93 px (Large Title, 34 pt), 77 px (Title 1, 28 pt) and 55-60 px (Title 2/3, 20-22 pt). In eye-tracking of 1,363 print ads, the text element captured attention in direct proportion to its surface area (Pieters & Wedel 2004).",
   "implication_for_our_agent": "Proposed sizes: cover hook at least 96-100 px (typically 100-140 px) so it still reads on the profile grid; inner-slide headlines 72-96 px; subheads 56-64 px. On the 952 px measure left by 64 px margins, that gives 2-3 words per line at 100-140 px (14-20 characters) and 3-4 words per line at 72-80 px (22-26 characters). So aim for 2-4 words per line and 2-4 lines, with text-wrap: balance. Give the headline real area; a small headline loses attention in proportion.",
   "sources": [
    "https://developer.apple.com/design/human-interface-guidelines/typography",
    "Pieters & Wedel 2004, J Marketing 68(2), https://doi.org/10.1509/jmkg.68.2.36.27794",
    "Derived: grid tile width and measure maths"
   ],
   "confidence": "medium"
  },
  {
   "claim": "The cover hook has to be read in one short look. People spend about 1.7 s on an item in the mobile feed (2.5 s on desktop), and 0.25 s of exposure is already enough for significant recall (Facebook IQ). Most ads get no more than one eye fixation, yet viewers recognise an ad, and the product of a typical ad, after 100 ms (Pieters & Wedel 2012). The gist of an image is detected in 13 ms (Potter et al. 2014). Adults read silently at about 238 words per minute (range 175-300), roughly 4 words per second (Brysbaert 2019). Each reading fixation lasts 200-250 ms and each saccade covers 7-9 characters. Meta recommends ad headlines of 40 characters or fewer.",
   "implication_for_our_agent": "Keep the cover hook to about 8 words and 45 characters at most (hard cap 12 words). The photo and hook together should give the topic within a quarter-second, and the hook should be fully readable in about 1.5 s. Score hooks by characters, not only words; 40 characters is about 7 English words.",
   "sources": [
    "https://www.facebook.com/business/news/insights/capturing-attention-feed-video-creative",
    "Pieters & Wedel 2012, Marketing Science, https://doi.org/10.1287/mksc.1110.0673",
    "https://news.mit.edu/2014/in-the-blink-of-an-eye-0116 (Potter et al. 2014)",
    "Brysbaert 2019, J Memory & Language, https://doi.org/10.1016/j.jml.2019.104047",
    "https://en.wikipedia.org/wiki/Eye_movement_in_reading",
    "https://www.facebook.com/business/help/223409425500940"
   ],
   "confidence": "medium"
  },
  {
   "claim": "Words per slide on inner slides. No public dataset links words per slide to carousel performance; the sources checked (Socialinsider, Metricool, Hootsuite, Sprout, Buffer, AuthoredUp, ContentDrips) publish none. Practitioner guidance agrees on one idea per slide with big, short text. Users read only about 20% of the words on a web page (28% at most). Slides that state the point as a sentence headline with visual evidence were understood significantly better (p<.01) than topic headlines with bullets. At 238 words per minute, 20 words take about 5 s, 35 words about 9 s and 50 words about 12.6 s. On Instagram, carousels longer than 10 slides get more reach, and the limit is 20.",
   "implication_for_our_agent": "These are inferred budgets, not measured ones. Headline: 12 words at most, written as a sentence that states the takeaway. Supporting copy: 25 words at most. Total: 35 words on text or device slides, 20 on photo-led slides, 14 on sparse slides (the existing rule), with a hard cap of 50. Split the slide rather than shrink the type. Tag words per slide in the recipe vocabulary so the learning loop can measure the real optimum per client.",
   "sources": [
    "https://www.nngroup.com/articles/how-little-do-users-read/",
    "https://www.assertion-evidence.com/research-papers.html (Garner et al. 2013)",
    "https://authoredup.com/blog/best-performing-content-on-linkedin",
    "https://contentdrips.com/blog/2026/06/carousel-hook-examples/",
    "https://www.socialinsider.io/blog/instagram-carousel/",
    "Brysbaert 2019"
   ],
   "confidence": "low"
  },
  {
   "claim": "How many text sizes. Nielsen Norman Group advises no more than 3 type sizes (small, medium, large) and at most 2 large elements. Material Design warns that too many type sizes and styles at once can wreck any layout. Apple's scale puts Large Title at 2.0x Body and captions at about 0.7x Body.",
   "implication_for_our_agent": "Allow at most 3 text sizes per slide: label about 32 px, body 44-48 px, headline 96-120 px. A fourth size is allowed only for a hero figure inside a data device. Keep neighbouring sizes at least 1.35x apart, with the headline at least 2x the body. Add a TYPE-SIZES gate that counts distinct computed font sizes per slide. The live templates use about 80 distinct px values between them, which suggests per-template size drift.",
   "sources": [
    "https://www.nngroup.com/articles/visual-hierarchy-ux-definition/",
    "https://m1.material.io/style/typography.html",
    "https://developer.apple.com/design/human-interface-guidelines/typography"
   ],
   "confidence": "medium"
  },
  {
   "claim": "Line length and line spacing. Research on continuous reading puts the best line length at 45-75 characters (66 ideal, Bringhurst). On screens, about 55 characters balanced speed and comprehension (Dyson & Haselgrove 2001). Baymard recommends 50-75, Butterick 45-90, and Material about 60, with 30-40 for condensed layouts; WCAG 1.4.8 caps lines at 80. Recommended line spacing is 120-145% (Butterick); Apple's Body is 17/22 (1.29) and its titles about 1.2.",
   "implication_for_our_agent": "On a 952 px measure, 44-48 px body gives about 36-43 characters per line, which suits glance reading on a phone. Cap body lines at about 45 characters by narrowing the text box, not by shrinking the type. Set body line height to 1.25-1.35. Set display line height to 1.0-1.15, and at least 1.1 for accented Latin (the Portuguese and French clients) or scripts with tall marks. The story-carousel h1 at 0.92 risks accents colliding with descenders.",
   "sources": [
    "https://en.wikipedia.org/wiki/Line_length",
    "https://baymard.com/blog/line-length-readability",
    "https://practicaltypography.com/summary-of-key-rules.html",
    "https://m1.material.io/style/typography.html",
    "https://developer.apple.com/design/human-interface-guidelines/typography"
   ],
   "confidence": "medium"
  },
  {
   "claim": "WCAG contrast mapped onto the canvas. WCAG 1.4.3 requires 4.5:1 for normal text and 3:1 for large text: at least 18 pt (24 CSS px) or 14 pt bold (about 18.5 CSS px). The 4.5:1 level compensates for vision of about 20/40, typical at around age 80. WCAG 1.4.11 requires 3:1 for graphic parts needed to understand the content, such as icons and chart marks. At 2.75-3.0 canvas px per pt, large text starts at about 66-72 px regular or 51-56 px bold. APCA sets Lc 75 as the body-text minimum (Lc 90 preferred) and Lc 60 for other content text. It allows Lc 45 at 36 px or 24 px bold (about 99 px or 66 canvas px) and caps large text at Lc 90. Material Design sets 4.5:1 as the minimum and 7:1 as preferred.",
   "implication_for_our_agent": "Add a CONTRAST gate measured on the rendered pixels. Compare each text box against the worst 5% of background pixels under it, not the CSS colour. Text under 72 px (under 56 px if bold) needs at least 4.5:1. Larger text needs at least 3:1. Aim for 7:1 or APCA Lc 75+ on body copy. Icons and data marks need at least 3:1 against what is next to them.",
   "sources": [
    "https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html",
    "https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html",
    "https://git.apcacontrast.com/documentation/APCA_in_a_Nutshell.html",
    "https://readtech.org/ARC/tests/bronze-simple-mode/?tn=criterion",
    "https://m1.material.io/style/typography.html"
   ],
   "confidence": "high"
  },
  {
   "claim": "Contrast in practice: accent colours and dark slides. WCAG 2 and APCA disagree on saturated orange. #FF6B2C on white is 2.84:1, which fails even the 3:1 large-text level (APCA Lc 54). On charcoal #1C1A17 it passes WCAG at 6.11:1, but APCA gives only Lc 47, enough for headlines only. White on that orange is also 2.84:1. Dark text on a light ground reads better at every age (Piepenbrock 2013), mostly because the display is brighter overall (Buchner 2009). In brief glances, light text on dark in a dark room needed the longest viewing time of the conditions tested (Dobres 2017), which is the night-scrolling case.",
   "implication_for_our_agent": "Restrict text in a brand's accent colour to headline sizes (about 66 px bold or 100 px regular and up) and never set white text on a mid-orange. On dark-ground slides, set body at 44-48 px or more in Regular to Semibold weights, and prefer an off-white over pure white for large display type. Compute WCAG and APCA for every text/colour pair when the brand kit is loaded, and ban failing pairs by size.",
   "sources": [
    "Computed with the WCAG 2 and APCA-W3 formulas",
    "Piepenbrock et al. 2013, Ergonomics, https://doi.org/10.1080/00140139.2013.790485",
    "Buchner et al. 2009, Ergonomics, https://doi.org/10.1080/00140130802641635",
    "Dobres et al. 2017, Applied Ergonomics, https://doi.org/10.1016/j.apergo.2016.11.001"
   ],
   "confidence": "medium"
  },
  {
   "claim": "Typeface and weight at a glance. A humanist sans cut total glance time by 10.6% against a square grotesque (in men) and gave 3.1% fewer errors (Reimer 2014). Humanist type was also more legible at a glance in both black-on-white and white-on-black (Dobres 2016). Under poor rendering, the lightest weight renders poorly and its glance legibility drops sharply (Dobres, Reimer & Chahine 2016). Apple advises against Ultralight, Thin and Light weights and says thin custom fonts should go larger. Upper case is more legible at small sizes (Arditi & Cho 2007). All caps are fine for under one line, with 5-12% extra letter spacing (Butterick).",
   "implication_for_our_agent": "Set body and labels in open-aperture sans faces at Regular to Semibold. Use condensed, square or thin display faces only at 96 px and above. Instagram's JPEG re-encode at 1,080 px wide counts as poor rendering, so avoid hairline strokes on must-read text. All-caps labels can sit at the 30 px floor with 5-12% tracking. The current 18-28% tracking on mono labels makes lines longer and pushes the eye harder.",
   "sources": [
    "Reimer et al. 2014, Ergonomics, https://doi.org/10.1080/00140139.2014.940000",
    "Dobres et al. 2016, Ergonomics, https://doi.org/10.1080/00140139.2015.1137637",
    "Dobres, Reimer & Chahine 2016, AutoUI, https://doi.org/10.1145/3003715.3005454",
    "https://developer.apple.com/design/human-interface-guidelines/typography",
    "Arditi & Cho 2007, Vision Research, https://doi.org/10.1016/j.visres.2007.06.010",
    "https://practicaltypography.com/summary-of-key-rules.html"
   ],
   "confidence": "medium"
  },
  {
   "claim": "Scrims and gradients over photos. Material Design says dark scrims should be 20-40% opacity and light scrims 40-60%, with some gradients up to 60%. It describes a gradient about 3x an app bar long, with its midpoint about 3/10 toward the dark end, placed where the text is rather than over the whole image. Nielsen Norman Group found a 30% black overlay too weak for white text over light photos; 50% or more was needed. They advise testing the worst-case image and using a floor fade or blur. By the WCAG formula, white text over a black scrim on a pure-white patch needs 42% opacity for 3:1, 54% for 4.5:1 and 65% for 7:1. If the brightest pixels under the text are sRGB 0.8, 27% and 42% are enough. Background texture hurts reading mainly when text contrast is low, and how much depends on the texture's spatial frequency (Scharff et al. 2000).",
   "implication_for_our_agent": "Size the scrim from measurement, not a fixed value. For each text box, take the 95th-percentile background luminance and solve for the black opacity that reaches the target ratio: 4.5:1 for body, 3:1 for text of 72 px and up. Hold that opacity behind the text block, feather it over 0.5-1x the block height, and fade to zero by about 50-55% of canvas height (this matches the existing rule). If the required opacity is above about 0.7, move the text, recrop, or add blur or a plate. Blur busy, detailed backgrounds such as foliage, crowds or signage. A drop shadow does not replace the scrim for small text.",
   "sources": [
    "https://m1.material.io/style/imagery.html",
    "https://www.nngroup.com/articles/text-over-images/",
    "Scharff, Hill & Ahumada 2000, Optics Express, https://doi.org/10.1364/OE.6.000081",
    "Computed with the WCAG 2 luminance formula",
    "/Users/albertkattan/Code/karos-agents/products/live/instagram-agent/references/taste-design-rules.md"
   ],
   "confidence": "high"
  },
  {
   "claim": "How much of the slide text should take up. Pictures capture attention regardless of their size, while text captures attention in proportion to its area, and the brand element passes attention on to the others (1,363 ads, more than 3,600 consumers). Meta has dropped any limit on text in ad images and retired its text overlay tool. It now says text 'shouldn't obstruct the visuals' and should use large, contrasting type. For 1:1 and 4:5 Instagram feed ads it says to keep the bottom and side edges free of key text.",
   "implication_for_our_agent": "These are inferred values. On photo-led slides, keep text plus scrim within about 45-55% of the height and leave at least a third of the photo clean (the existing rule); the text boxes themselves come to about 15-30% of the canvas. On type-led slides the headline can act as the picture, filling 40-60% of the live area, with at least 30% left as empty space. Keep must-read text out of the 64 px side margins and about 100 px from the bottom. On a 4:5 cover, keep text at least about 100 px from the sides, because a 3:4 grid tile crops about 34 px off each side.",
   "sources": [
    "Pieters & Wedel 2004, https://doi.org/10.1509/jmkg.68.2.36.27794",
    "https://www.facebook.com/business/help/388369961318508",
    "https://www.facebook.com/business/help/980593475366490",
    "Derived: grid-crop maths"
   ],
   "confidence": "low"
  },
  {
   "claim": "Instagram draws its own slide counter in the top-right corner of a carousel. Carousels hold up to 20 items. The templates' .eyebrow label sits right there, at top 56-64 px and right 48-56 px in story-carousel.html and verdict-ranking.html.",
   "implication_for_our_agent": "Keep a top-right zone of about 200x140 px clear of must-read text; the size is an estimate. Move eyebrows to the top-left or into the text block, and add this zone to the gate's collision checks.",
   "sources": [
    "https://blog.hootsuite.com/instagram-carousel/",
    "/Users/albertkattan/Code/karos-agents/products/live/instagram-agent/assets/templates/story-carousel.html",
    "/Users/albertkattan/Code/karos-agents/products/live/instagram-agent/assets/templates/verdict-ranking.html"
   ],
   "confidence": "medium"
  },
  {
   "claim": "Faces and text pull the eye; good photos drive engagement. In free viewing, people fixated faces 16.6x and text 11.1x more often than control regions matched for size and position, and found it hard not to look (Cerf 2009). It is the visual features of text that pull attention, not its meaning (Wang & Pomplun 2012). On Instagram, photos with faces were 38% more likely to get likes and 32% more likely to get comments across 1M photos; the number, age and gender of faces made no difference (Bakhshi 2014). For brand posts, professional high-quality photos raised engagement on both Twitter and Instagram, while faces and image-text fit helped only on Twitter (Li & Xie 2020). Across 46.9K Instagram posts from 59 brands, positive high-arousal images drove engagement and informative appeals did not (Rietveld 2020). In eye-tracking of the Facebook feed, posts with pictures and links drew more attention (Vraga 2016).",
   "implication_for_our_agent": "On covers, use a real, professional photo of the subject, a face where it fits, and a high-arousal moment. Put the hook next to that focal point, not in the opposite corner. Keep text out of the photos themselves (already a rule), because stray text steals fixations from the hook.",
   "sources": [
    "Cerf, Frady & Koch 2009, J Vision, https://doi.org/10.1167/9.12.10",
    "Wang & Pomplun 2012, J Vision, https://doi.org/10.1167/12.6.26",
    "Bakhshi, Shamma & Gilbert 2014, CHI, https://doi.org/10.1145/2556288.2557403",
    "Li & Xie 2020, JMR, https://doi.org/10.1177/0022243719881113",
    "Rietveld et al. 2020, J Interactive Marketing, https://doi.org/10.1016/j.intmar.2019.06.003",
    "Vraga, Bode & Troller-Renfree 2016, https://doi.org/10.1080/19312458.2016.1150443"
   ],
   "confidence": "medium"
  },
  {
   "claim": "Icons, pictograms and data graphics. Eye-tracking shows users ignore purely decorative images: product images got 4.4 fixations against 0.9 for decorative ones, and real staff photos beat stock. Only a few icons are universally understood, so they need text labels. Decorative SmartArt can mislead. In charts, the title and text should carry the message. Pictograms do not get in the way and can improve recognition, and colour and recognisable objects make a chart more memorable (Borkin 2013, 2015). In ads, dense clutter of small visual detail hurts attention, while a well-designed composition helps it (Pieters, Wedel & Batra 2010).",
   "implication_for_our_agent": "Treat icons as labelled wayfinding, such as numbered steps, never as the thing that stops the scroll or as content. Give every data device a sentence title that states the takeaway. Use pictograms only when they stand for the data, such as unit icons. Keep icons and data marks at 3:1 contrast or better. Cut small-detail clutter (textures, many small elements) while keeping a deliberate composition.",
   "sources": [
    "https://www.nngroup.com/articles/photos-as-web-content/",
    "https://www.nngroup.com/articles/icon-usability/",
    "https://www.assertion-evidence.com/research-papers.html (Wolfe et al. 2023)",
    "Borkin et al. 2013, https://doi.org/10.1109/TVCG.2013.234",
    "Borkin et al. 2016, https://doi.org/10.1109/TVCG.2015.2467732",
    "Pieters, Wedel & Batra 2010, https://doi.org/10.1509/jmkg.74.5.048"
   ],
   "confidence": "medium"
  },
  {
   "claim": "Where the eye lands first. When a scene appears, viewers first look to the centre of the screen, whatever the image contains (Tatler 2007), and text attracts gaze on its own.",
   "implication_for_our_agent": "Place the cover hook in the central vertical band or at the top-left reading start, not hugging an edge. A hook anchored at the bottom works only if it is large (96 px or more) and sits on a strong scrim. This is a lower-confidence carry-over from desktop scene-viewing studies to a scrolling phone feed.",
   "sources": [
    "Tatler 2007, J Vision, https://doi.org/10.1167/7.14.4",
    "Cerf et al. 2009"
   ],
   "confidence": "low"
  },
  {
   "claim": "How carousels behave in the feed affects layout. Instagram re-serves carousels to users who did not engage the first time. Over 35M posts in 2025, carousels had a 0.55% engagement rate against 0.52% for reels and 0.37% for images (0.50/0.48/0.33 in Q2 2026). Carousels got 9x the saves of single images across 24.3M posts. Carousels longer than 10 slides got more reach. On LinkedIn, documents got 1.39x reach across 3M posts, and 6-8 slides are recommended.",
   "implication_for_our_agent": "Make slide 2 work as a second cover, using the same size and word-budget rules as the cover. Spread dense material across more slides of 35 words or fewer rather than packing it in. Saves reward slides worth keeping for reference, so denser save slides mid-deck are fine as long as they respect the size floors.",
   "sources": [
    "https://sproutsocial.com/insights/instagram-carousel/",
    "https://www.socialinsider.io/social-media-benchmarks/instagram",
    "https://www.socialinsider.io/blog/instagram-carousel/",
    "https://metricool.com/press-release-instagram-study-2026/",
    "https://authoredup.com/blog/best-performing-content-on-linkedin"
   ],
   "confidence": "medium"
  },
  {
   "claim": "The quality gate in karoslabs/skills/instagram-agent/engine/scripts/fit.mjs checks layout only: BROKEN-IMAGE, CLIPPED, COLLISION, DEAD-SPACE, EMPTY, HEADER, MARGIN, OUT-OF-FRAME, SPARSE-ABUSE and SPILL. Nothing checks type size, contrast, line length or word count, even though the skill's pre-flight asks for every figure to be legible at thumbnail size.",
   "implication_for_our_agent": "Turn these parameters into gates that auto-reject on the rendered 1080 px file: MIN-TYPE (x-height normalised), CONTRAST (worst pixels under each text box, sized by text size), TYPE-SIZES (3 or fewer), LINE-LENGTH (body 45 characters or fewer), WORDS (cover 8 or fewer, slide 35, cap 50), SAFE-ZONE (top-right counter, sides, bottom) and GRID-HOOK (cover hook 96 px or more). These are measurable, so they will not drift the way prose rules do.",
   "sources": [
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/skills/instagram-agent/engine/scripts/fit.mjs",
    "/Users/albertkattan/Code/karos-agents/products/live/instagram-agent/references/taste-design-rules.md"
   ],
   "confidence": "high"
  }
 ],
 "numbers": [
  {
   "parameter": "Instagram served width / supported aspect ratios",
   "value": "Up to 1,080 px wide. 1.91:1 to 3:4 kept at original resolution (1080x566 to 1080x1440). Wider uploads sized down to 1,080 px.",
   "source": "https://help.instagram.com/1631821640426723"
  },
  {
   "parameter": "Carousel max items; counter position",
   "value": "20 items; slide counter shown top-right",
   "source": "https://blog.hootsuite.com/instagram-carousel/ ; https://sproutsocial.com/insights/instagram-carousel/"
  },
  {
   "parameter": "Common phone viewport widths (Aug 2026)",
   "value": "414 px 13.63%, 360 px 9.25%, 390 px 6.81%, 393 px 5.27%, 384 px 4.35%, 360x780 3.17%",
   "source": "https://gs.statcounter.com/screen-resolution-stats/mobile/worldwide"
  },
  {
   "parameter": "Canvas px per phone pt/dp (1080 canvas, full-width feed)",
   "value": "2.61 (414 wide), 2.75 (393 wide, reference), 3.0 (360 wide, worst case)",
   "source": "Derived"
  },
  {
   "parameter": "Phone viewing distance",
   "value": "32.2 cm web pages (range 19-60); 36.2 cm texts (range 17.5-58); print reference 40 cm",
   "source": "Bababekova et al. 2011, PMID 21499163"
  },
  {
   "parameter": "Observed phone text size",
   "value": "Web 0.8M (range 0.3-1.4M), about 0.21 deg x-height at 32 cm, about 37 canvas px; texts 1.1M, about 0.25 deg, about 51 px",
   "source": "Bababekova 2011 plus derived conversion (1M = 1.454 mm x-height)"
  },
  {
   "parameter": "Fluent print-size range",
   "value": "0.2 to 2 deg x-height (1.4 to 14 mm at 40 cm)",
   "source": "Legge & Bigelow 2011, https://doi.org/10.1167/11.5.8"
  },
  {
   "parameter": "0.2 deg x-height as canvas font size (x-height 0.52 em)",
   "value": "About 36 px on a 6.1-inch phone at 32 cm; 40 px on a mini phone or at 36 cm; 33 px on a Pro Max",
   "source": "Derived from Legge & Bigelow, Bababekova and device specs"
  },
  {
   "parameter": "iOS type sizes as canvas px (393 pt reference)",
   "value": "Min 11 pt = 30 px; Body 17 = 47; Title 3 20 = 55; Title 2 22 = 60; Title 1 28 = 77; Large Title 34 = 93 (x 3.0 on a 360 dp phone: 33 / 51 / 60 / 66 / 84 / 102)",
   "source": "https://developer.apple.com/design/human-interface-guidelines/typography plus derived"
  },
  {
   "parameter": "Recommended text-size floors (1080 canvas)",
   "value": "Any text 30 px (x-height about 16); body 40 px (36 px secondary only; x-height about 21); default body 44-48 px",
   "source": "Synthesis of Apple HIG, Legge & Bigelow, Bababekova"
  },
  {
   "parameter": "Profile-grid legibility",
   "value": "Tile about 130 pt, so 0.12 pt per canvas px. 96 px = 11.6 pt, 72 px = 8.7 pt, 48 px = 5.8 pt. Cover hook needs 96-100 px or more.",
   "source": "Derived"
  },
  {
   "parameter": "Headline sizes",
   "value": "Cover hook 96-140 px; inner headline 72-96 px; subhead 56-64 px; 2-4 words per line",
   "source": "Synthesis (Apple HIG plus grid and measure maths)"
  },
  {
   "parameter": "Characters per line on a 952 px measure (64 px margins)",
   "value": "36 px about 48-53; 44 px about 39-43; 48 px about 36-40; 72 px about 24-26; 96 px about 18-20; 120 px about 14-16",
   "source": "Derived (average glyph width 0.50-0.55 em)"
  },
  {
   "parameter": "Optimal line length (continuous reading)",
   "value": "45-75 cpl, 66 ideal (Bringhurst); 55 cpl on screen (Dyson & Haselgrove 2001); 50-75 (Baymard); 45-90 (Butterick); about 60, and 30-40 for condensed layouts (Material); 80 or fewer (WCAG 1.4.8)",
   "source": "https://en.wikipedia.org/wiki/Line_length ; https://baymard.com/blog/line-length-readability ; https://practicaltypography.com/summary-of-key-rules.html ; https://m1.material.io/style/typography.html"
  },
  {
   "parameter": "Line spacing",
   "value": "120-145% for body (Butterick); iOS Body 17/22 = 1.29; titles about 1.2",
   "source": "https://practicaltypography.com/summary-of-key-rules.html ; Apple HIG"
  },
  {
   "parameter": "Max type sizes per layout",
   "value": "3 (small, medium, large); at most 2 large elements",
   "source": "https://www.nngroup.com/articles/visual-hierarchy-ux-definition/"
  },
  {
   "parameter": "WCAG text contrast",
   "value": "4.5:1 normal; 3:1 large (18 pt / 24 CSS px, or 14 pt bold / about 18.5 CSS px); 4.5:1 matches about 20/40 vision",
   "source": "https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html"
  },
  {
   "parameter": "WCAG large-text threshold on a 1080 canvas",
   "value": "66-72 px regular or more; 51-56 px bold or more",
   "source": "Derived (x 2.75-3.0)"
  },
  {
   "parameter": "WCAG non-text contrast",
   "value": "3:1 for graphic parts needed to understand the content (icons, chart marks)",
   "source": "https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html"
  },
  {
   "parameter": "APCA thresholds",
   "value": "Body minimum Lc 75 (Lc 90 preferred); other content text Lc 60; large text (36 px or more, or 24 px bold) Lc 45; large text maximum Lc 90",
   "source": "https://git.apcacontrast.com/documentation/APCA_in_a_Nutshell.html ; https://readtech.org/ARC/tests/bronze-simple-mode/?tn=criterion"
  },
  {
   "parameter": "Material contrast",
   "value": "Minimum 4.5:1, preferred 7:1",
   "source": "https://m1.material.io/style/typography.html"
  },
  {
   "parameter": "Example brand-colour contrast",
   "value": "#FF6B2C on white 2.84:1 (APCA Lc 54); #FF6B2C on #1C1A17 6.11:1 (APCA Lc -47); white on #1C1A17 17.36:1 (Lc -106); #F2EEE6 on #1C1A17 15.0:1",
   "source": "Computed (WCAG 2 / APCA-W3)"
  },
  {
   "parameter": "Material scrim opacities",
   "value": "Dark 20-40%; light 40-60%; gradients up to 60%; length about 3x app bar with midpoint 3/10 toward the dark end",
   "source": "https://m1.material.io/style/imagery.html"
  },
  {
   "parameter": "NN/g overlay opacity",
   "value": "30% black too weak for white text on light photos; 50% or more needed",
   "source": "https://www.nngroup.com/articles/text-over-images/"
  },
  {
   "parameter": "Black scrim opacity for white text over worst-case white",
   "value": "0.42 for 3:1; 0.54 for 4.5:1; 0.65 for 7:1 (if brightest background is sRGB 0.8: 0.27 / 0.42)",
   "source": "Computed (WCAG luminance)"
  },
  {
   "parameter": "Mobile feed attention",
   "value": "1.7 s per item on mobile vs 2.5 s on desktop; 0.25 s exposure enough for significant recall",
   "source": "https://www.facebook.com/business/news/insights/capturing-attention-feed-video-creative"
  },
  {
   "parameter": "Ad gist / image gist",
   "value": "Most ads get one fixation or none; ad vs editorial and a typical ad's product identified at 100 ms; image gist at 13 ms",
   "source": "Pieters & Wedel 2012, https://doi.org/10.1287/mksc.1110.0673 ; https://news.mit.edu/2014/in-the-blink-of-an-eye-0116"
  },
  {
   "parameter": "Silent reading rate",
   "value": "238 wpm non-fiction (range 175-300); 260 wpm fiction",
   "source": "Brysbaert 2019, https://doi.org/10.1016/j.jml.2019.104047"
  },
  {
   "parameter": "Reading eye movements",
   "value": "Fixation 200-250 ms; saccade 7-9 characters; saccade 20-40 ms",
   "source": "https://en.wikipedia.org/wiki/Eye_movement_in_reading"
  },
  {
   "parameter": "Share of words read on a web page",
   "value": "About 20% on average (28% at most); +4.4 s per extra 100 words",
   "source": "https://www.nngroup.com/articles/how-little-do-users-read/"
  },
  {
   "parameter": "Meta ad text lengths",
   "value": "Headline 40 characters; primary text 125 characters (1-3 lines); no limit on text in the image",
   "source": "https://www.facebook.com/business/help/223409425500940 ; https://www.facebook.com/business/help/388369961318508"
  },
  {
   "parameter": "Word budget per slide",
   "value": "Cover up to 8 words / 45 characters (cap 12); inner headline up to 12; support up to 25; text or device slide up to 35; photo-led slide up to 20; sparse slide up to 14; hard cap 50",
   "source": "Derived (reading rate x dwell) plus existing SPARSE-ABUSE rule"
  },
  {
   "parameter": "Faces on Instagram",
   "value": "+38% likelihood of likes, +32% of comments (1M photos); number, age and gender of faces no effect",
   "source": "Bakhshi et al. 2014, https://doi.org/10.1145/2556288.2557403"
  },
  {
   "parameter": "Gaze capture by faces and text",
   "value": "Faces 16.6x, text 11.1x more fixations than matched regions; saliency model with faces and text AUC over 84%",
   "source": "Cerf et al. 2009, https://doi.org/10.1167/9.12.10"
  },
  {
   "parameter": "Pieters & Wedel eye-tracking corpus",
   "value": "1,363 print ads, more than 3,600 consumers; pictorial attention independent of size; text attention proportional to its area",
   "source": "https://doi.org/10.1509/jmkg.68.2.36.27794"
  },
  {
   "parameter": "Decorative vs informative images",
   "value": "4.4 fixations on product images vs 0.9 on decorative images",
   "source": "https://www.nngroup.com/articles/photos-as-web-content/"
  },
  {
   "parameter": "Humanist vs square grotesque",
   "value": "-10.6% total glance time (men); -3.1% errors",
   "source": "Reimer et al. 2014, https://doi.org/10.1080/00140139.2014.940000"
  },
  {
   "parameter": "Instagram engagement rate by format",
   "value": "2025: carousels 0.55%, reels 0.52%, images 0.37% (35M posts, 447,613 pages); Q2 2026: 0.50 / 0.48 / 0.33",
   "source": "https://www.socialinsider.io/social-media-benchmarks/instagram"
  },
  {
   "parameter": "Carousel saves",
   "value": "9x single-image saves (24.3M posts, 375K accounts)",
   "source": "https://metricool.com/press-release-instagram-study-2026/"
  },
  {
   "parameter": "Carousel length",
   "value": "More than 10 slides gets more reach on Instagram; LinkedIn documents 6-8 slides (3M+ posts), Metricool LinkedIn 7-15",
   "source": "https://www.socialinsider.io/blog/instagram-carousel/ ; https://authoredup.com/blog/best-performing-content-on-linkedin ; https://metricool.com/linkedin-carousel/"
  },
  {
   "parameter": "4:5 cover in a 3:4 grid tile",
   "value": "About 34 px cropped from each side; keep cover text at least about 100 px from the side edges",
   "source": "Derived (assumes the 3:4 profile grid the agent's rules already use)"
  },
  {
   "parameter": "Safe zones for organic Instagram carousels",
   "value": "Sides 64 px (current gate); bottom about 100 px or more; keep the top-right ~200x140 px clear for the counter",
   "source": "Derived (estimate) plus Hootsuite counter note plus Meta feed safe-zone guidance"
  }
 ]
}
```

## research:karos-archive

```json
{
 "findings": [
  {
   "claim": "The type system is the most reusable asset. It uses three faces, each with one job: Spectral 600 (display serif) for headlines and figures, Hanken Grotesk 400 for body, and JetBrains Mono 500 (uppercase, tracked 0.18-0.2em) only for eyebrows, datelines, indices and chip labels. All 121 font-size declarations hang off one scale token (--ts: 1.0 until 28 Jul, 1.2 after). At 1.2 on the 1080x1440 canvas: cover headline 108-118px, inner headline 77-115px (line-height 1.3, tracking -0.012em), body 37px (line-height 1.55, max 952px wide), eyebrow and dateline 23-24px, credit 19px, hero figure 276px (line-height 0.94, tracking -0.03em). The roughly 3:1 headline-to-body ratio is what makes the slides read as editorial. The owner complained about type twice. Size: 'text 20% bigger, we can't see', fixed with --ts 1.2. Mono overuse: 'use this font in fewer places, not smaller', which cut on-canvas mono by 46%.",
   "implication_for_our_agent": "Make this the L1 editorial type kit: one display face, one grotesk, and one mono restricted to labels. Every size is a base value multiplied by one scale token. Floors on a 1080-wide canvas: body 34px, headline 74px. The mono never sets credits, sources, captions or body text. Industry kits swap the faces but keep the roles and the ratios.",
   "sources": [
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/skills/instagram-agent/engine/templates/karos-core.css",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/skills/instagram-agent/engine/templates/come-up.html",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-28-celebrity-comeups/internal/RUN.md",
    "/Users/albertkattan/Code/karos-agents/docs/product-feedback/content-engine.md (06 Jul v2/v3 feedback)",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-06-template-launch/internal/qa-report.md"
   ],
   "confidence": "high"
  },
  {
   "claim": "The marker is the signature device: a square #FF6B2C band 1.08em tall behind italic Spectral in #141414, padding 0 0.26em, no radius. It survives thumbnail scale (at a 390px profile-grid tile it is the only element besides the headline that still reads) and it lands on the payoff phrase ('a cut', 'named us', 'fell from space', 'never expired'; median 2 words, max 5). But it rides 123 of 151 headlines (81%) and 27 of 29 covers, so by the third post it has become wallpaper and every cover reads the same.",
   "implication_for_our_agent": "Keep a highlighter as a brand-kit device (colour set per brand) but ration it: at most one per slide, 1-3 words, only on the phrase that carries the surprise or the number, on no more than half the slides of a carousel, and never on two consecutive slides. The other slides spend their one accent on a data mark or a figure. Ink on orange passes contrast (6.5:1).",
   "sources": [
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/skills/instagram-agent/engine/templates/karos-core.css (.hl)",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/skills/instagram-agent/engine/posts/*/data.json (accent fields)",
    "/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/kl-audit/live-grid-sim.jpg",
    "/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/research/scrape/karoslabs/sheet-best.jpg"
   ],
   "confidence": "high"
  },
  {
   "claim": "The strongest covers are real, specific photographs of the actual subject, full-bleed: Jordan in 1984, the Daft Punk helmets, the Brady portrait of Barnum, the Salviati Kairos. A bottom-up charcoal scrim (rgba(26,26,26) at 0.94 on the edge, 0.80 at 16%, 0.46 at 34%, clear by 54%; the tall variant clears by 62%) holds a bottom-left stack 96-104px off the bottom and 64px off the sides: dateline, a 2-3 line headline with the marker, at most 3 lines of body, and the credit 36px off the bottom. The top half of the photo stays clean. Two of the three live posts above the median use this cover (Jordan 4.67x, Kairos 3.0x); the third uses the paper list cover.",
   "implication_for_our_agent": "Default cover for any post about a person, product or place: the subject photo full-bleed, with the face or product in the top 55% above the scrim, a bottom-left text stack, and scrim generated only where the text sits. The planner must never move the subject's photo to slide 2.",
   "sources": [
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-28-celebrity-comeups/client/01-comeup-michael-jordan/slide-01.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-09-music-collab/client/01-come-up-daft-punk/slide-01.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-08-week2-3/client/04-marketer-legend/slide-01.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-06-launch-post-kairos/client/slide-01.png",
    "/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/research/scrape/karoslabs/stats.json"
   ],
   "confidence": "medium"
  },
  {
   "claim": "The archival plate produced the most collectible slides in the archive. The image sits in a 14px warm-dark mat (gradient #211c17 to #14110d) with a 1px orange keyline at 22% opacity, an inset keyline at 30%, a long soft shadow, and an italic Spectral museum caption beneath. It turned public-domain ads, posters and period photos into its best slides: Listerine 1925, the Barnum & Bailey poster, Walker at the wheel in 1911. Since 28 Jul the plate is the elastic middle of a flex column, so longer copy shrinks it instead of colliding with it. It fails on modern press headshots (Reynolds, Rihanna), where it reads as a framed celebrity photo.",
   "implication_for_our_agent": "Ship 'plate' as an L1 device for artifacts: ads, packaging, documents, historical photos, and a client's own screenshots or work samples. Use object-fit: contain inside a flex-elastic middle. Send contemporary portraits to full-bleed instead.",
   "sources": [
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-06-template-launch/client/05-special-edition/slide-02.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-08-week2-3/client/04-marketer-legend/slide-05.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-06-template-launch/client/02-marketer-legend/slide-03.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-28-celebrity-comeups/client/08-comeup-ryan-reynolds/slide-02.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/skills/instagram-agent/engine/templates/karos-core.css (.kplate, .pstack)"
   ],
   "confidence": "high"
  },
  {
   "claim": "The rebuilt charts are strong and portable because they all follow one emphasis rule: everything in neutral ink, with one accent mark carrying the point. The set: a 10x10 proportion grid (95 ink cells, 5 orange); bars with the value inside once the fill reaches 72%; before/after delta cards ('None' to '828,773', with the after card outlined and its figure in orange); versus columns (logos in 168px circles, the winner outlined); a scorecard of filled vs outline diamonds; chain chips joined by orange arrows (the rule, the fine, the ad); a 2x2 map; a timeline of orange diamonds on a hairline. Measured accent area is a median 1.3% of the slide (p90 2.9%) against a cap of about 5%. Illustrative devices say on the slide that they are not measured data. The weak spot is label length: the staircase's last step wrapped to three lines ('Publish, moment gone / day 14').",
   "implication_for_our_agent": "Port these as a shared device library chosen by data shape: share uses the grid, comparison bars, change the delta, rivalry versus, process a chain or staircase, position the 2x2, history the timeline. Hard rules: one accent mark per device; accent at most 5% of the slide; a declared count or proportion mode; an automatic 'illustration, not measured data' footnote whenever magnitudes are unsourced; and label caps enforced by the geometry gate (for example 12 characters for bar values, 18 for step labels).",
   "sources": [
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-06-template-launch/client/04-by-the-numbers/slide-02.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-28-celebrity-comeups/client/04-comeup-beyonce/slide-03.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-28-celebrity-comeups/client/05-h2h-coke-pepsi/slide-02.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-28-celebrity-comeups/client/05-h2h-coke-pepsi/slide-04.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-28-celebrity-comeups/client/07-breakdown-duolingo-tiktok/slide-04.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-28-celebrity-comeups/client/01-comeup-michael-jordan/slide-03.png",
    "/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/kl-audit/pixels.py",
    "/Users/albertkattan/Code/karos-agents/docs/product-feedback/instagram-agent.md (2026-07-28 items 7-8)"
   ],
   "confidence": "high"
  },
  {
   "claim": "The launch post's concept devices give an argument a shape without data: the two-word split (Chronos vs Kairos, each with a line icon, the chosen side in orange), the triad (too early / THE MOMENT / too late, with the middle cell filled orange), and the name turn (Kairos to Karos at 125px). They are the only devices in the archive built to carry a point of view rather than a statistic.",
   "implication_for_our_agent": "Keep split, triad and turn as POV devices for posts that argue the brand's own view, which the topic engine needs far more of (see the topics finding). The same single-accent rule applies: one filled cell.",
   "sources": [
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-06-launch-post-kairos/client/slide-02.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-06-launch-post-kairos/client/slide-05.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-06-launch-post-kairos/internal/RUN.md"
   ],
   "confidence": "medium"
  },
  {
   "claim": "The hero-stat slide reads even at thumbnail size (the 95% cover): a Spectral 600 figure at 250-276px, a 132x12px orange rule, a one-sentence label at 41px, 2-3 figure chips and a source line. It is also predictable. It appears in 13 of 29 posts and sits at slide 4 in 10 of them, and 7 of the 13 campaign and come-up posts open with the same four slide types (hook, body, body, stat), so a follower learns where the number will be.",
   "implication_for_our_agent": "Keep the stat as a device but let the arc planner move it (cover, slide 2, 3 or the penultimate slide). Allow the number on a photo cover as a figure chip over the subject instead of a number replacing the subject. Treat slide 2 as a second cover (Karos's own research notes carousels get a second feed impression): it must carry either the strongest image or the headline number.",
   "sources": [
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-06-template-launch/client/01-campaign-story/slide-04.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-09-music-collab/client/05-campaign-story-berghain/slide-05.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/skills/instagram-agent/engine/posts/*/data.json (slide type sequences)",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-06-template-launch/internal/research/format-research.md (section 2)"
   ],
   "confidence": "medium"
  },
  {
   "claim": "The only contrast in the grid came from the paper playbook lane: a #F2F1EC ground, #1A1A1A ink, and a white index card with hairline rows and orange mono numbers 01-05, on 20 of 167 slides. The paper cover 'Five rules that never expired' was one of three live posts above the median (3.0x), but its paper twin landed on the median, so the signal is weak. On 28 Jul the brand moved to a single ground, and the 28 Jul batch is 64 of 82 flat charcoal slides. Orange as small text on paper is only 2.5:1.",
   "implication_for_our_agent": "Every brand kit declares at least two grounds, assigned by lane or by post, so the profile grid alternates. On a light ground the accent is used only as fill (marker, bars, diamonds) and small labels switch to ink.",
   "sources": [
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-06-template-launch/client/03-playbook/slide-03.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-08-week2-3/client/02-playbook/slide-02.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/skills/instagram-agent/engine/templates/playbook.html (ONE ground note, 2026-07-28)",
    "/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/research/scrape/karoslabs/stats.json"
   ],
   "confidence": "low"
  },
  {
   "claim": "The copy is heavy for Instagram, and the tightest post is the best one. Carousels ran 4-8 slides (median 6; ten posts at 5). The Jordan post has 5 slides: a photo cover, a structure device (a fee vs a share), a chain device, the $6.99bn stat, and an 11-word one-sentence closer with the marker; it is the only live outlier. Across the archive the median slide carries 42 words on canvas (IQR 36-50, max 102), body text has a median of 29 words (max 78) and headlines a median of 6 (max 11). Blocks of 3-5 body lines sit over the lower third of the photos. On 28 Jul the owner also asked for shorter sentences.",
   "implication_for_our_agent": "Default arc of 5-7 slides. Per-slide budget: headline of 8 words or fewer, body of 25 or fewer, 35 words on canvas in total. At least one sparse slide (12 words or fewer) per post, and a one-sentence closer. Enforce this with a word-budget gate alongside the geometry gate.",
   "sources": [
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/skills/instagram-agent/engine/posts/comeup-michael-jordan/data.json",
    "/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/kl-audit/copy_stats.py",
    "/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/research/scrape/karoslabs/carousel-B1-Dba_DXJDS06.jpg",
    "/Users/albertkattan/Code/karos-agents/docs/product-feedback/instagram-agent.md (2026-07-28)"
   ],
   "confidence": "medium"
  },
  {
   "claim": "Every figure carries an on-slide source and every photo a credit, set in the body face at 19px and 60% ink on one line. Folklore numbers that could not be sourced were cut (the Stratos cost, Fenty's revenue, the '5,000 ads a day'). The sourcing is quiet on the slide and backs the brand's no-guessed-numbers position.",
   "implication_for_our_agent": "Every data device gets a mandatory source slot and every photo a credit slot, in the body face at 60% ink and one line at most. Full attribution goes in the caption's last line, never in the middle.",
   "sources": [
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-08-week2-3/internal/qa-report.md",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-28-celebrity-comeups/internal/RUN.md (Numbers deliberately cut)",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-08-week2-3/client/03-by-the-numbers/slide-02.png"
   ],
   "confidence": "high"
  },
  {
   "claim": "Real, specific, rights-clean photos of the subject made the best slides, and stock was never used. But the Wikimedia-only rights posture left modern celebrities and brands with thin coverage. Rihanna's only usable photo was 651x867, and the Coke/Pepsi sources were logo files (512x161 and 800x800), so the 28 Jul batch fell back to logos and hero numbers. Photos under the sourcing floor (900px short edge; Walker at 643px and 498px) shipped only as small plates.",
   "implication_for_our_agent": "For clients, the first image source is the client's own library. Before committing to a people or product topic, the planner checks that at least one photo of 1440px or more on the short edge exists for a full-bleed cover. If none does, pick a data or POV format rather than a faceless people post.",
   "sources": [
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-28-celebrity-comeups/internal/photo-sources/*/manifest.json",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-28-objects/internal/photo-sources/obj-cola/manifest.json",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-06-template-launch/internal/qa-report.md (section 6)"
   ],
   "confidence": "medium"
  },
  {
   "claim": "Topics made the feed generic. All 29 posts retell someone else's fame: Coca-Cola appears in three, alongside Red Bull, Nike/Jordan, Spotify, Duolingo, Liquid Death, Burger King and McDonald's, Beyonce, Rihanna, Taylor Swift and Daft Punk. The 175-subject topic pool and the 62-row catalogue contain no Karos-owned subject: no client work, agent output, own data or behind-the-scenes. Karos's own research named Because of Marketing (320K), Marketing Examples and Growth.Design as the owners of exactly this genre. Only the launch post says something only Karos could say. The bio promises 'We engineer the perfect moment for your brand', and no post shows that happening.",
   "implication_for_our_agent": "The design can be kept; topic selection is what needs to change. Add a proprietary-source rule: at least 1 in 3 posts is built from the client's own material (product, customers, data, process, results), and every borrowed-fame post ends on the client's own angle rather than a general maxim. In the layer model, L3 client material outranks L2 industry case studies when the planner picks a topic.",
   "sources": [
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/skills/instagram-agent/topic-catalog.yaml",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-06-template-launch/internal/research/topic-pools.md",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-06-template-launch/internal/research/format-research.md",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-06-template-launch/internal/research/audience-brief.md",
    "/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/research/scrape/karoslabs/profile.json"
   ],
   "confidence": "high"
  },
  {
   "claim": "Covers hide the subject behind a riddle formula. 11 of 29 cover headlines follow 'The [noun] that/who [verb phrase]' ('The campaign that fell from space', 'The band that became robots', 'The rookie who asked for a cut'). Across the 20 subject-led covers, the name is in the display headline only twice (the two legend posts). It appears only in the 24px mono dateline 11 times, which is unreadable in the grid, and in neither 7 times. The campaign hook the research ranked first ('brand + precise number', as in 'This rebrand cost Tropicana $55M') was used on 0 of 5 campaign covers; the number waited until slide 4. The dateline or fact rail is also something the owner later called unnecessary furniture (8 Sep).",
   "implication_for_our_agent": "Cover gate: the recognisable subject (person or brand) is named in the display headline or in a label of at least 48px, and the post's strongest sourced number is on the cover. Lint for the 'The X that Y' template and down-rank it. The dateline is optional, and it never carries the name alone.",
   "sources": [
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/skills/instagram-agent/engine/posts/*/data.json (slide 1 headline, facts, eyebrow)",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/skills/instagram-agent/seeds.yaml (hook_shapes)",
    "/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/kl-audit/live-grid-sim.jpg",
    "/Users/albertkattan/.claude/projects/-Users-albertkattan-Karos-Labs-CMO/memory/albert-copy-must-mean-something.md"
   ],
   "confidence": "high"
  },
  {
   "claim": "Headlines lean on a few stock moves. Of 151 headlines, 12 are 'X, not Y' antitheses ('Attention is earned, not rented', 'Design the chain, not the ad'), 6 say something 'became the ad/advertising', and 23 are imperative maxims. Closers are interchangeable lessons that could end any post: 'Own the channel and the name', 'Make the product worth filming', 'Put the customer in the product', 'Build the proof into the product'. Two posts close almost identically ('New tools. Same rules.' and 'New tools. Old truths.'). 'Save this' appears in 14 of 29 captions and on 9 of 27 closer slides. The owner's standing rule from 8 Sep already rejects this register: aphorisms with no fact in them.",
   "implication_for_our_agent": "Copy gates: at most one antithesis per post. Closers must contain a specific from the post (a name, number or date) and pass a trigram-similarity check against the client's earlier closers. No stock save or follow lines. Every slide must state a fact (who, what, where, when, how much).",
   "sources": [
    "/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/kl-audit/heads.json",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-28-celebrity-comeups/client/11-breakdown-spotify-wrapped/slide-05.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-06-template-launch/client/05-special-edition/slide-06.png",
    "/Users/albertkattan/.claude/projects/-Users-albertkattan-Karos-Labs-CMO/memory/albert-copy-must-mean-something.md"
   ],
   "confidence": "high"
  },
  {
   "claim": "The template's skeleton shows through. Inner eyebrows name the beat instead of the content: 'The lesson' x15, 'The catalyst' x10, 'The break' x9, 'Why it worked' x7, 'The mechanism' x5. 26 of 29 covers spend their only top-right orange on the internal series name ('The come-up', 'The campaign files', 'The breakdown', 'Head to head'), although the owner asked on 6 Jul that covers not announce the internal format. The live 100-year playbook still shipped with a SPECIAL EDITION chip. On the live account the series numbering went out of order: the first come-up posted was 'no 5', and playbook 'no 1' and 'no 2' were swapped against the local numbering.",
   "implication_for_our_agent": "Eyebrows carry content (date and place, a figure, a quote's source), and beat names are banned from rendered text. Series and format names never render on the canvas. The arc planner draws each post's slide order from a pool and never repeats the previous post's first three slide types. Ordinals appear only when the scheduler guarantees posting order.",
   "sources": [
    "/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/kl-audit/copy_stats.py",
    "/Users/albertkattan/Code/karos-agents/docs/product-feedback/instagram-agent.md (item 17)",
    "/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/research/scrape/karoslabs/posts.json",
    "/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/research/scrape/karoslabs/sheet-worst.jpg"
   ],
   "confidence": "high"
  },
  {
   "claim": "The slides look alike. 113 of 167 slides sit on the same #1A1A1A charcoal, and 96 (57%) are flat type or device slides with the text block in one of two positions (top-left or bottom-left) at the same 64px margins. Every photo slide uses the same bottom scrim and bottom-left stack. Since 28 Jul the line-drawn Kairos crest is auto-inserted on closers that have no photo or device (4 of the 10 new closers), always the same size and position. In the 28 Jul batch, 64 of 82 slides are flat charcoal, so a profile grid reads as one dark block punctuated by orange rectangles.",
   "implication_for_our_agent": "Make layout variety a rule: at least three distinct compositions per carousel (full-bleed photo, split image and text, plate, device-dominant, type-only), no two consecutive slides with the same composition, at least one image slide in every three, and brand illustration at most once per post.",
   "sources": [
    "/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/kl-audit/pixels.py",
    "/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/kl-audit/sheets/2026-07-28-celebrity-comeups-1.jpg",
    "/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/kl-audit/sheets/2026-07-28-celebrity-comeups-2.jpg",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-28-celebrity-comeups/internal/RUN.md (crest default-on)"
   ],
   "confidence": "medium"
  },
  {
   "claim": "15 of 29 covers carry no photograph. That suits the stat and playbook posts, but in the 28 Jul batch it spread to people posts. The Rihanna and Reynolds come-ups open on a bare number ('40', '25%') with the person neither pictured nor named, and the face appears only on slide 2 as a framed plate.",
   "implication_for_our_agent": "If the post is about a person, the cover shows that person (a verified photo) and names them. Hero-number covers are reserved for data posts. With no rights-clean photo of the subject, the topic does not run in a people lane.",
   "sources": [
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-28-celebrity-comeups/client/02-comeup-rihanna/slide-01.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-28-celebrity-comeups/client/08-comeup-ryan-reynolds/slide-01.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/skills/instagram-agent/engine/posts/*/data.json"
   ],
   "confidence": "high"
  },
  {
   "claim": "Labels on photos rely on a text-shadow alone and fail contrast. Sampling the pixels in the eyebrow slot, the orange eyebrow gets less than 3:1 on 29 of 54 full-bleed photo slides (Stratos, Barnum, Berghain, Tomorrowland, Ice Bucket; on the Taylor Swift cover it sits on red neon). The paper-white wordmark slot drops below 3:1 on 17 photo slides. Orange #FF6B2C is 6.1:1 on charcoal but 2.5:1 on paper. Some photos also carry large lettering in the headline zone: the Share a Coke cover sets 'The bottle' over a printed 'Sandy'.",
   "implication_for_our_agent": "Before export, sample the luminance under every text box. Orange text is allowed only where the background's relative luminance is 0.032 or less (4.5:1); otherwise add a local charcoal pill or micro-scrim, or switch the label to paper ink. Add a top micro-scrim whenever the top 15% of a photo has L above 0.2. Reject crops with large detected text in the headline zone. Place the brand lockup on the cover and closer only, not on every photo slide (in line with the owner's 8 Sep 'no furniture on photos').",
   "sources": [
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-06-template-launch/client/01-campaign-story/slide-01.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-06-template-launch/client/01-campaign-story/slide-06.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-28-celebrity-comeups/client/06-comeup-taylor-swift/slide-01.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-08-week2-3/client/01-campaign-story/slide-01.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-06-template-launch/internal/qa-report.md (section 8)",
    "/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/kl-audit/pixels.json"
   ],
   "confidence": "high"
  },
  {
   "claim": "Before the geometry gate, flat slides were top-loaded with the lower 30-40% empty: the Stratos stat, '250M+', Berghain's 'No 1', the Walker quote, the Yelp closer. In the 6-8 Jul batches, 22 of 63 flat slides (35%) carry an empty horizontal band of 380 canvas px or more. The owner flagged 'too blank / too empty' in three separate rounds (6 Jul v2, 6 Jul v3, 28 Jul). The 28 Jul fit.mjs gate (which fails bands over 380px, sparse one-line slides excepted) cut this to 4 of 64.",
   "implication_for_our_agent": "Build every slide as one flex column with the device or image as the elastic middle. A dead-space gate fails any empty band over about 26% of canvas height, except on slides deliberately marked sparse. Adding words is not an accepted fix.",
   "sources": [
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-08-week2-3/client/08-by-the-numbers/slide-04.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-06-template-launch/client/02-marketer-legend/slide-07.png",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-28-celebrity-comeups/internal/RUN.md",
    "/Users/albertkattan/Code/karos-agents/docs/product-feedback/content-engine.md",
    "/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/kl-audit/pixels.py"
   ],
   "confidence": "high"
  },
  {
   "claim": "Captions follow one formula. They run a median 164 words (range 88-200). All 29 open with a series label ('The come-up, no 5: Michael Jordan.'), so the preview line is spent on that label instead of a hook. Ten use the identical hashtag set (#marketing #brandstrategy #marketinghistory #karoslabs), and credit paragraphs sit before the hashtags.",
   "implication_for_our_agent": "The caption's first line is the hook, with the name and the number, in 125 characters or fewer. Hashtags come from a topic-specific pool, not a fixed set. Credits go in the final line.",
   "sources": [
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/**/caption.txt",
    "/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/research/scrape/karoslabs/posts.json"
   ],
   "confidence": "medium"
  },
  {
   "claim": "The live account is too small to say anything about design. It has 22 followers, follows 0 accounts, and holds 9 carousels posted daily from 12 to 18 Jul and on 30-31 Jul, with nothing since (55 days to 24 Sep). Of the 15-post queue dated 2 Aug to 28 Sep, only Jordan and Liquid Death went out, early. Likes run 3-11 (median 3; seven of nine posts got exactly 3) and there are 3 comments in total. The best post (Jordan, 11 likes and 1 comment) beats the median by 8 likes, which is within the reach of a friends-and-team audience. The 13.6% median engagement rate is inflated by the tiny follower base.",
   "implication_for_our_agent": "In the learning loop, weight lessons from this account at near zero, below any promotion threshold. 'Did not perform' was mainly distribution: no outbound follows, no collab posts published, no reels, and a stalled cadence. Take design priors from benchmark accounts and the owner's verdicts, and topic and copy priors from the genericness findings above.",
   "sources": [
    "/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/research/scrape/karoslabs/stats.json",
    "/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/research/scrape/karoslabs/profile.json",
    "/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/research/scrape/karoslabs/posts.json",
    "/Users/albertkattan/Code/karos-agents/clients/karoslabs/outputs/instagram-agent/2026-07-28-celebrity-comeups/internal/ig-queue.json"
   ],
   "confidence": "high"
  }
 ],
 "numbers": [
  {
   "parameter": "Canvas and export",
   "value": "1080x1440 CSS px (3:4), exported at 2x as 2160x2880 PNG; 198 of the 200 PNGs are slides (2 are Liquid Death source cutouts)",
   "source": "karos-core.css; PIL audit of the outputs folder"
  },
  {
   "parameter": "Archive size",
   "value": "34 post folders / 198 slide PNGs = 29 unique posts / 167 unique slides (the 5 music posts were re-rendered on 28 Jul)",
   "source": "outputs/instagram-agent; engine/posts/*/data.json"
  },
  {
   "parameter": "Slides per post (archive)",
   "value": "4-8, median 6, mean 5.8; 5 slides x10 posts, 6 x8, 7 x7, 4 x3, 8 x1",
   "source": "engine/posts/*/data.json"
  },
  {
   "parameter": "Slides per post (live)",
   "value": "Liquid Death 5, Jordan 5, 100-year playbook 6, 95-5 rule 4, Five rules 7, Walker 8, Stratos 6, Five forces 7, Kairos 7 (median 6)",
   "source": "scrape/karoslabs/stats.json"
  },
  {
   "parameter": "Slide mix",
   "value": "96 flat type/device (57%), 54 full-bleed photo (32%), 17 framed plate (10%)",
   "source": "engine/posts/*/data.json"
  },
  {
   "parameter": "Ground usage",
   "value": "113/167 slides flat charcoal #1A1A1A; 20/167 paper #F2F1EC (playbook lane only); 28 Jul batch: 64/82 flat charcoal",
   "source": "kl-audit/pixels.py"
  },
  {
   "parameter": "Type scale token --ts",
   "value": "1.0 for the 6-9 Jul renders; 1.2 (+20%) from 28 Jul; copy columns opened to 952px at the same time (otherwise about 17% fewer characters per line)",
   "source": "karos-core.css; 2026-07-28 RUN.md"
  },
  {
   "parameter": "Side margin / content width",
   "value": "64px / 952px (on a 1080px canvas)",
   "source": "karos-core.css --mx"
  },
  {
   "parameter": "Headline (Spectral 600)",
   "value": "96px x ts = 115px (mid 76 = 91px, small 62 = 74px); line-height 1.3 (at least 1.3 when a marker rides it); tracking -0.012em; text-wrap balance",
   "source": "karos-core.css .headline"
  },
  {
   "parameter": "Cover headline",
   "value": "90-98px x ts = 108-118px (mid 80 = 96px, small 66 = 79px); text-shadow 0 2px 20px rgba(20,20,20,0.62)",
   "source": "karos-core.css; come-up.html"
  },
  {
   "parameter": "Inner photo-beat headline / closer headline",
   "value": "64px x ts = 77px / 72px x ts = 86px",
   "source": "come-up.html"
  },
  {
   "parameter": "Body (Hanken Grotesk 400)",
   "value": "31px x ts = 37px, line-height 1.55, max-width 952px, 92% ink",
   "source": "karos-core.css .body-text"
  },
  {
   "parameter": "Eyebrow (JetBrains Mono 500)",
   "value": "19px x ts = 23px, uppercase, tracking 0.2em, #FF6B2C, top 62px / right 64px, max-width 560px",
   "source": "karos-core.css .eyebrow"
  },
  {
   "parameter": "Dateline / fact rail",
   "value": "19-20px x ts = 23-24px mono, tracking 0.18-0.2em, 78-82% ink, 7px orange diamond separators",
   "source": "karos-core.css .kicker/.fact-rail"
  },
  {
   "parameter": "Wordmark lockup",
   "value": "54px head disc at top 48px / left 64px + 'Karos Labs' Spectral 400 at 33px x ts = 40px",
   "source": "karos-core.css .logo-tl/.km-word"
  },
  {
   "parameter": "Credit / source line",
   "value": "15.5px x ts = 19px Hanken, 60% ink, 36px from bottom; cover credit Spectral italic 17.5px x ts = 21px",
   "source": "karos-core.css .credit"
  },
  {
   "parameter": "Hero figure",
   "value": "230/176/128px x ts = 276/211/154px, line-height 0.94, tracking -0.03em; orange rule 132x12px; mono label 23px",
   "source": "karos-core.css .hero-fig"
  },
  {
   "parameter": "Stat slide",
   "value": "figure 208/176/150px x ts = 250/211/180px; label 34px x ts = 41px; chip figures 52/43/36px x ts; chip labels 19.5px x ts; zone top 172px, bottom 96px",
   "source": "come-up.html .stat"
  },
  {
   "parameter": "Quote slide",
   "value": "mark 200-300px x ts; quote Spectral italic 500 at 70px x ts = 84px, line-height 1.26; attribution 21px x ts = 25px",
   "source": "karos-core.css .quote-*"
  },
  {
   "parameter": "Marker band",
   "value": "height 1.08em, padding 0 0.26em, radius 0, italic, #141414 on #FF6B2C; on 123/151 headlines (81%) and 27/29 covers; phrase median 2 words (IQR 1-3, max 5)",
   "source": "karos-core.css .hl; data.json accent fields"
  },
  {
   "parameter": "Photo scrim",
   "value": "standard: rgba(26,26,26) 0.94 @0% -> 0.80 @16% -> 0.46 @34% -> 0 @54%; tall: 0.96 -> 0.86 @22% -> 0.52 @42% -> 0 @62%",
   "source": "karos-core.css .scrim"
  },
  {
   "parameter": "Copy block offsets",
   "value": "bottom 96px (body slides), 104px (come-up cover), 110px (closer); chart/stat zones top 172px, bottom 92-96px; plate stack top 176px, bottom 96px, 34px vertical padding",
   "source": "karos-core.css; come-up.html"
  },
  {
   "parameter": "Archival plate",
   "value": "14px padding; mat gradient #211c17 -> #14110d; 1px keyline rgba(255,107,44,0.22) + 7px-inset keyline at 0.30; shadow 0 30px 80px -30px rgba(0,0,0,0.7); caption Spectral italic 21px x ts = 25px",
   "source": "karos-core.css .kplate"
  },
  {
   "parameter": "Glow",
   "value": "720px radial, accent at 13%, blur 55px, at most 1 per slide, centred behind the device",
   "source": "karos-core.css .glow"
  },
  {
   "parameter": "Palette",
   "value": "ground #1A1A1A, ink #F2F1EC, accent #FF6B2C, ink-on-accent #141414, muted #9C9CA3, line #34343B; paper #F2F1EC, card #FFFFFF, paper line #DAD6CC, paper muted #6B6A63",
   "source": "karos-core.css :root"
  },
  {
   "parameter": "Accent area per slide",
   "value": "median 1.3%, p90 2.9% of slide pixels (brand cap about 5%; an all-orange dot matrix hit 13% and was switched to ink)",
   "source": "kl-audit/pixels.py; 2026-07-28 RUN.md"
  },
  {
   "parameter": "Contrast",
   "value": "orange on charcoal 6.1:1; orange on paper 2.5:1; #141414 on orange 6.5:1; eyebrow slot <3:1 on 29 of 54 full-bleed photo slides; wordmark slot <3:1 on 17 photo slides; orange text needs background luminance <=0.032 for 4.5:1",
   "source": "kl-audit pixel contrast sampling"
  },
  {
   "parameter": "Headline length",
   "value": "median 6 words (IQR 5-7, max 11)",
   "source": "kl-audit/copy_stats.py"
  },
  {
   "parameter": "Body length (slides with body)",
   "value": "median 29 words (IQR 23-35, max 78)",
   "source": "kl-audit/copy_stats.py"
  },
  {
   "parameter": "On-canvas words per slide",
   "value": "median 42 (IQR 36-50, max 102; the wordiest are steps and meaning slides)",
   "source": "kl-audit/copy_stats.py"
  },
  {
   "parameter": "Best post's closer",
   "value": "11 words, one sentence with the marker, no body (Jordan)",
   "source": "engine/posts/comeup-michael-jordan/data.json"
  },
  {
   "parameter": "Cover headline formula",
   "value": "'The X that/who Y' on 11 of 29 covers; antithesis 'X, not Y' in 12 of 151 headlines; 'became the ad' family 6; imperative maxims 23",
   "source": "kl-audit/heads.json"
  },
  {
   "parameter": "Subject name on cover",
   "value": "of 20 subject covers: in the display headline 2, only in the 24px mono dateline 11, in neither 7",
   "source": "engine/posts/*/data.json slide 1"
  },
  {
   "parameter": "Covers carrying the series label in the eyebrow",
   "value": "26 of 29",
   "source": "engine/posts/*/data.json"
  },
  {
   "parameter": "Beat-name eyebrows",
   "value": "'the lesson' 15, 'the catalyst' 10, 'the break' 9, 'why it worked' 7, 'the mechanism' 5",
   "source": "kl-audit/copy_stats.py"
  },
  {
   "parameter": "Stat-slide position",
   "value": "in 13 of 29 posts; at slide 4 in 10 of those 13; 7 of 13 campaign/come-up posts open with the same types (hook, body, body, stat)",
   "source": "engine/posts/*/data.json"
  },
  {
   "parameter": "Covers without a photograph",
   "value": "15 of 29 (including the Rihanna and Reynolds come-ups)",
   "source": "engine/posts/*/data.json"
  },
  {
   "parameter": "'Save this' usage",
   "value": "in 14 of 29 captions and on 9 of 27 closer slides",
   "source": "caption.txt files; data.json"
  },
  {
   "parameter": "Caption length",
   "value": "archive median 164 words (range 88-200); live captions 92-179 words including credits and hashtags; 4 lowercase hashtags each, one identical set used 10 times",
   "source": "caption.txt; posts.json"
  },
  {
   "parameter": "Dead space",
   "value": "flat slides with an empty band of 380 canvas px or more: 22 of 63 (35%) in the 6-8 Jul batches, 4 of 64 in the 28 Jul batch; fit.mjs threshold 380px = 26% of 1440",
   "source": "kl-audit/pixels.py; 2026-07-28 RUN.md"
  },
  {
   "parameter": "Mono footprint reduction",
   "value": "2,253 -> 1,208 on-canvas mono characters (-46%; playbook -69%) after the owner's 6 Jul feedback",
   "source": "2026-07-06-template-launch/internal/qa-report.md"
  },
  {
   "parameter": "Photo sourcing floor",
   "value": "900px short edge minimum for sourcing; sub-floor photos (Walker 643px and 498px; Rihanna 651x867) shipped only as plates; recommended full-bleed floor 1440px short edge",
   "source": "photo-sources manifests; template-launch qa-report"
  },
  {
   "parameter": "Topic pool and catalogue",
   "value": "175 pool subjects (40 campaigns, 30 legends, 40 principles, 40 stats, 25 concepts) and 62 catalogue rows across 8 lanes; 0 Karos-owned subjects",
   "source": "topic-pools.md; topic-catalog.yaml"
  },
  {
   "parameter": "Live account",
   "value": "22 followers, 0 following, 9 posts (all carousels); likes 3-11 (median 3, seven posts at exactly 3), 3 comments in total; median engagement 3 (likes + 3 x comments), median ER 13.6%; best: Jordan, 14 engagement (4.67x median)",
   "source": "scrape/karoslabs/stats.json, profile.json"
  },
  {
   "parameter": "Live cadence",
   "value": "one post a day 12-18 Jul, then 30 and 31 Jul, then silent for 55 days (to 24 Sep); planned 15-post queue for 2 Aug-28 Sep not published",
   "source": "posts.json; ig-queue.json"
  },
  {
   "parameter": "Review coverage for this report",
   "value": "37 slides read at full 2160x2880, all 198 slides on 8 labelled contact sheets, all 30 live carousel slides (4 sheets) plus the best/worst cover sheets",
   "source": "kl-audit/sheets/*.jpg"
  },
  {
   "parameter": "Paid API or scraping spend for this analysis",
   "value": "$0 (local files and the existing scrape only)",
   "source": "this run"
  }
 ]
}
```
