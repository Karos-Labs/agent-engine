# Resolved numeric values per client DNA, the input compileDNA checks against the L1 MUST gates.
# Sizes are px on the 1080x1440 canvas as [min, max]. Roles: H headline (or the hero NAME), T text/deck/support,
# S meta/source/eyebrow. S_caps True = the meta is tracked all-caps (26-28px allowed); otherwise S >= 30.
# photoHook True = a declared photo-hook cover, the only case where cover H may sit between 64 and 96px.
# coverKind: "photo" = text over a full-bleed photograph (<=16 words in all), "plate"/"card" (<=20 words).
# logo: the DNA may set only variant, position, treatment and presence; size is always "L1 equal-area".
EQ = "L1 equal-area"
RESOLVED = {
 "karoslabs": {
  "cover": {"H": [100, 110], "T": [44, 44], "S": [30, 30]}, "interior": {"H": [64, 72], "T": [44, 44], "S": [30, 30]},
  "S_caps": False, "photoHook": False, "coverKind": "photo", "coverWords": 16, "interiorWordsMax": 25,
  "logo": {"variant": "full lockup", "position": "top-left", "treatment": "bare", "presence": "every slide", "size": EQ},
 },
 "geektime": {
  "cover": {"H": [68, 76], "T": [41, 46], "S": [30, 30]}, "interior": {"T": [44, 48], "S": [30, 30]},
  "S_caps": False, "photoHook": True, "coverKind": "card", "coverWords": 20, "interiorWordsMax": 35,
  "logo": {"variant": "white horizontal wordmark", "position": "navy tab at the house card's top-right corner", "treatment": "on the navy tab", "presence": "every slide", "size": EQ},
 },
 "thepitchbydeel": {
  "cover": {"H": [96, 104], "T": [44, 44], "S": [26, 26]}, "interior": {"H": [65, 65], "T": [44, 44], "S": [26, 26]},
  "S_caps": True, "photoHook": False, "coverKind": "photo", "coverWords": 8, "interiorWordsMax": 35,
  "logo": {"variant": "logo-light on Stage and photos, logo-dark on Paper", "position": "top-right below the counter", "treatment": "bare", "presence": "every slide", "size": EQ},
 },
 "hankypanky": {
  "cover": {"H": [64, 72], "T": [36, 40]}, "interior": {"H": [64, 72], "T": [36, 40]},
  "S_caps": False, "photoHook": True, "coverKind": "photo", "coverWords": 8, "interiorWordsMax": 8,
  "logo": {"variant": "kit SVG", "position": "bottom-centre", "treatment": "bare", "presence": "last slide or none", "size": EQ},
 },
 "kindlyyours": {
  "cover": {"H": [96, 100], "T": [43, 50]}, "interior": {"H": [96, 100], "T": [43, 50]},
  "S_caps": False, "photoHook": False, "coverKind": "plate", "coverWords": 10, "interiorWordsMax": 12,
  "logo": {"variant": "logo-dark on light grounds, logo-light on photos and dark grounds", "position": "bottom-centre", "treatment": "over a colour field on photos, clear space = cap height of the k", "presence": "cover and last slide", "size": EQ},
 },
 "sitti": {
  "cover": {"H": [96, 110], "T": [48, 56]}, "interior": {"H": [60, 80], "T": [40, 44]},
  "S_caps": False, "photoHook": False, "coverKind": "plate", "coverWords": 7, "interiorWordsMax": 9,
  "logo": {"variant": "lockup on cover and closer, bare slice on interiors", "position": "bottom-right", "treatment": "bare", "presence": "every slide", "size": EQ},
 },
 "xodigital": {
  "cover": {"H": [96, 102], "T": [44, 44], "S": [26, 26]}, "interior": {"H": [76, 80], "T": [44, 44], "S": [26, 26]},
  "S_caps": True, "photoHook": False, "coverKind": "plate", "coverWords": 12, "interiorWordsMax": 25,
  "logo": {"variant": "light mark on navy, navy rounded-square badge on cream", "position": "top-left on the text margin", "treatment": "bare on navy, the client's badge on cream", "presence": "every slide", "size": EQ},
 },
 "dontechno": {
  "cover": {"H": [96, 120], "T": [48, 48], "S": [32, 32]}, "interior": {"H": [60, 60], "S": [32, 32]},
  "S_caps": True, "photoHook": False, "coverKind": "photo", "coverWords": 12, "interiorWordsMax": 20,
  "logo": {"variant": "circular monogram PNG", "position": "top-left", "treatment": "bare, top veil when the frame is bright", "presence": "every slide", "size": EQ},
 },
 "n3": {
  "cover": {"H": [96, 104], "S": [30, 30]}, "interior": {"T": [44, 48], "S": [30, 30]},
  "S_caps": False, "photoHook": False, "coverKind": "card", "coverWords": 5, "interiorWordsMax": 25,
  "logo": {"variant": "logotype-jour or logotype-nuit by ground", "position": "header band", "treatment": "kit SVG inlined byte for byte", "presence": "every slide and the map closer", "size": EQ},
 },
}
