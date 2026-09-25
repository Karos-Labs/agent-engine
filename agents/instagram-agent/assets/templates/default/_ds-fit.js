/* ============================================================================
   THE FIT LADDER — one for the whole set.
   ----------------------------------------------------------------------------
   Generated into every template between the `@ds:fit-start` / `@ds:fit-end`
   markers by `scripts/sync-design-system.ts`. Edit HERE, never in a plate.

   WHAT IT REPLACES. Every template used to carry its own ladder that picked a
   size from `textContent.length` against bespoke thresholds. Three problems,
   all of them things the owner saw:

   1. IT GUESSED. A character count does not know the face, the script, the
      reviewer's `--ts`, or how wide the words are, so each ladder needed its
      own thresholds AND a second set shifted ~15% for `ts-l`. Eight ladders,
      sixteen threshold sets, and a long statement still printed over its own
      kicker. This one MEASURES the laid-out box and steps until it fits, so
      there is nothing to tune and nothing to keep in sync.

   2. IT READ THE HIDDEN TWIN. `textContent` reads a `display: none` subtree, so
      on a marked render the host counted its copy twice and a 30-character
      headline scored 60 and took a step it did not need. Geometry only sees
      the visible twin, so a marked and an unmarked render of the same copy now
      set the same size.

   3. IT ONLY EVER SHRANK. Short copy stayed at the role's own step and left the
      plate mostly empty — the owner's "the first slide is relatively empty and
      boring", and the near-blank interior plate. This ladder tries ONE STEP UP
      first and keeps it when it fits.

   Every value it sets resolves to a step of the six-step scale. It cannot
   produce a size that is not on the scale, which is the property that took a
   carousel from 25 distinct sizes to the set the scale declares.
   ========================================================================== */
(function () {
  var plate = document.querySelector('.plate');
  if (!plate) { window.__CAROUSEL_READY__ = true; return; }

  var hosts = Array.prototype.slice.call(document.querySelectorAll('[data-fitted]'));
  if (!hosts.length) { window.__CAROUSEL_READY__ = true; return; }
  var primary = hosts.filter(function (h) { return h.getAttribute('data-fitted') === 'primary'; });

  /* EVERY ELEMENT ON THE PLATE, DEEPEST FIRST — not just the fitted hosts.
     A host is where a STEP is applied; overflow happens wherever there is text.
     Measured: `.me-title` in a list row and `.quote-attr` under a quotation are
     neither of them fit hosts, and both reported — the attribution printed 15px
     into the reserved foot band, on top of the @handle, which is the same class
     of defect as the closer's CTA and was invisible for the same reason.
     Deepest first so a child's ink is closed before its parent is measured,
     otherwise a container inherits its children's overflow and pays twice. */
  var content = Array.prototype.slice.call(plate.querySelectorAll('*'))
    .filter(function (el) { return el.tagName !== 'IMG' && el.tagName !== 'BR'; })
    .map(function (el) { var d = 0, n = el; while (n && n !== plate) { d++; n = n.parentElement; } return { el: el, depth: d }; })
    .sort(function (a, b) { return b.depth - a.depth; })
    .map(function (x) { return x.el; });

  /* Overflow means either of the two things a reader sees: the stack is taller
     than the field between the brand band and the foot band, or a single
     unbreakable line is wider than the measure. */
  /* The field the copy is allowed to occupy: the plate's content box, which is
     everything between the reserved brand band and the reserved foot band. */
  function field() {
    var r = plate.getBoundingClientRect();
    var cs = getComputedStyle(plate);
    return { top: r.top + parseFloat(cs.paddingTop), bottom: r.bottom - parseFloat(cs.paddingBottom) };
  }

  function overflows() {
    if (plate.scrollHeight > plate.clientHeight + 1) return true;

    /* GEOMETRY, NOT JUST `scrollHeight`. Content that overflows in the block-
       START direction is invisible to `scrollHeight` — a flex item aligned to
       the end, or an auto margin on an item taller than its track, grows UP and
       reports nothing. That is how the cover's figure came to sit 132px above
       its band, under the brand mark, on a plate the ladder called fitted.
       This limb measures what the render check measures: is any fitted host
       outside the field the plate reserved for it? */
    var f = field();
    for (var g = 0; g < content.length; g++) {
      var box = content[g].getBoundingClientRect();
      if (box.height === 0 || box.width === 0) continue;
      if (box.top < f.top - 1 || box.bottom > f.bottom + 1) return true;
    }

    /* ── A BOX ESCAPING ITS OWN PARENT, WHICH THE PLATE'S FIELD CANNOT SEE. ──
       The limb above asks whether anything left the field the PLATE reserved.
       That is not the same question the render check asks: `render-carousel`'s
       probe compares each element against ITS OWN PARENT, so a box that grows
       out of its container while staying inside the plate is `clipped` to the
       interest floor and invisible here.

       Measured on this tree: the cover's figure device is 359px in a band whose
       content box came out 254px, and the band aligns its item to the block-end
       — so the excess went out of the TOP of the band, 49px above it, while
       still sitting 7px below the plate's own content edge. The ladder reported
       `data-fit-step=0` (nothing to fix) and the render check reported one
       element overflowing its own box. Both were right about their own
       question; only one of them was asked.

       The three exclusions are the probe's, for the probe's reasons: a parent
       that is not `overflow: visible` has already declared what happens to
       content leaving it, an absolutely positioned child is placed rather than
       laid out, and a 2px tolerance covers a display face whose glyph box sits
       a subpixel or two above its line box. Same question, same answer — which
       is the only way the ladder can fix what the check will report. */
    for (var k = 0; k < content.length; k++) {
      var child = content[k];
      var owner = child.parentElement;
      if (!owner || owner === plate) continue;
      var childBox = child.getBoundingClientRect();
      if (childBox.height === 0 || childBox.width === 0) continue;
      var childStyle = getComputedStyle(child);
      if (childStyle.position === 'absolute' || childStyle.position === 'fixed') continue;
      /* An INLINE box's rect is the union of its line fragments, sized by the
         face's ascent and descent rather than by `line-height` — it starts a
         few px above the block that contains it at every size, which is
         typography rather than escape. The probe excludes it for the same
         reason; the two have to agree or the ladder shrinks type to chase a
         finding that is never reported. */
      if (childStyle.display === 'inline' || childStyle.display === 'contents') continue;
      if (getComputedStyle(owner).overflow !== 'visible') continue;
      var ownerBox = owner.getBoundingClientRect();
      if (ownerBox.height === 0) continue;
      if (childBox.top < ownerBox.top - 2) return true;
    }

    /* THE CANVAS ITSELF. A host that sets a `max-inline-size` in `ch` grows with
       the step it is given, so at the top of the ladder a 15ch measure at the
       figure step is wider than the plate — the first render of this system
       widened the document to 1194px against a 1080px canvas. `body` clips, so
       the host's own `scrollWidth` looks fine and only the document shows it. */
    if (document.documentElement.scrollWidth > document.body.clientWidth + 1) return true;
    for (var i = 0; i < hosts.length; i++) {
      if (hosts[i].scrollWidth > hosts[i].clientWidth + 1) return true;
    }
    return false;
  }

  function set(list, value) {
    for (var i = 0; i < list.length; i++) list[i].setAttribute('data-fit', String(value));
  }

  /* ── CLOSE THE INK THE LINE BOX DOES NOT CONTAIN. ──
     A display face paints above its first line and below its last by an amount
     that depends on the face, the script, the size and the line height all at
     once. `scrollHeight` reports it, and clause B turns that report into
     `clipped` — so a plate that looks perfect burns every redraft it is given.
     Three constants were tried here and each fixed one face and missed the
     next: a flat em value, the register's own `--mk-face-bleed` (which the
     system emits as `0em` on the headline anyway), and a Hebrew-only rule.
     Measuring is exact, needs no table, and costs one reflow per host. */
  function closeInk() {
    for (var i = 0; i < content.length; i++) content[i].style.paddingBlockEnd = '';
    /* All of it on the END edge, not half on each. `scrollHeight` only ever
       reports the overflow BELOW the content box — ink above the first line is
       invisible to it — so splitting the correction in two closed half of the
       gap and left the rest reported. Two rounds because adding padding can
       reflow the host and change the number by a pixel or two. */
    for (var round = 0; round < 2; round++) {
      for (var j = 0; j < content.length; j++) {
        var h = content[j];
        /* Inline boxes only: `scrollHeight` and `clientHeight` are both 0 on an
           inline element, and block padding does not move its box either, so
           padding one is noise that never closes anything. An emphasis mark's
           bleed is paid for by its HOST, which is a block. */
        var display = getComputedStyle(h).display;
        if (display === 'inline' || display === 'contents' || display === 'none') continue;
        var over = h.scrollHeight - h.clientHeight;
        if (over <= 0) continue;
        var current = parseFloat(h.style.paddingBlockEnd) || 0;
        h.style.paddingBlockEnd = current + over + 'px';
      }
    }
  }

  function pass() {
    /* Start every host at its own step. */
    set(hosts, 0);
    closeInk();

    /* Grow: only the primary host, only one step, only if it still fits. A plate
       whose copy is short should read as a deliberate large statement rather
       than as a small thing adrift in a grey field. */
    /* GROW WHILE IT FITS, not exactly once. The interest floor refuses a plate
       whose largest empty rectangle covers more than 22% of it, and measured on
       this tree the bottom-anchored stacks were reporting 28-44% — the same
       thing the owner sees as *"חלק מהשקפים ריקים"*. One rung was not enough to
       close that on a short headline. Each rung is still a step of the scale,
       and the loop stops the moment anything would overflow, so filling the
       plate can never become clipping it. */
    /* ONE RUNG, NOT TWO. Two rungs took a nine-word headline from 94px to
       200px: six lines wall-to-wall, which is not a headline a CMO sets, and
       which the interest floor reads as a GRAPHIC rather than as text — a cell
       inside a 150px stroke holds one colour, so `textBoxShare` fell to 0.2%
       and the floor reported "the ground layers rendered and the copy did not"
       about a plate that had rendered perfectly. Filling a plate is the bounded
       object's job; the type's job is to be read. */
    /* ── AND IT MUST NOT GROW AT THE BOUNDED OBJECT'S EXPENSE, WHICH IS THE
          ONE CASE WHERE THIS LOOP INVERTS ITS OWN PURPOSE. ──
       The rung exists to SHRINK the largest empty rectangle. On the cover it
       grew it. `.cov-field` is the elastic item there, so every pixel the
       headline takes is a pixel off a FULL-WIDTH band, and it is spent on a
       text column that is tall and narrow: measured on CI 35306664288, the
       worst row in the sweep is `he rtl short s -> cover  rect 0,452 304x988`
       — a 304px column against the left edge running from the band's foot to
       the bottom of the plate, LER 0.1931 against a swept limb of 0.1913, on a
       plate reading `flat` 0.7802. Hebrew sets short words, so at the smallest
       scale the grown line reaches nowhere near its own measure and the rung
       bought 224px of bare column for a bigger headline.

       A full-width band covers more frame per pixel of height than a ranged
       text column can, so the trade is losing on the very metric the rung is
       for. MEASURED, not assumed: the band's own height is read before and
       after the rung, and a rung that shortened it is given back. Short copy
       on the cover then sets at its role's step with the subject at the extent
       the run declared, which is what `--cover-band` means.

       Scoped to `.cov-field` by name. The other seven plates have no such item
       and their loop is untouched — this is a finding about one plate's
       composition, not a new rule for the set. */
    var objects = plate.querySelectorAll('.cov-field');
    var objectExtent = function () {
      var total = 0;
      for (var o = 0; o < objects.length; o++) total += objects[o].getBoundingClientRect().height;
      return total;
    };
    if (primary.length) {
      var extentBefore = objectExtent();
      var grown = 0;
      while (grown > -1 && !overflows()) {
        grown -= 1;
        set(primary, grown);
        closeInk();
        /* 1px of tolerance, for the same reason the overflow limbs carry one:
           a subpixel layout difference is not the object giving ground. */
        if (objectExtent() < extentBefore - 1) { grown += 1; set(primary, grown); closeInk(); break; }
      }
      if (overflows()) { grown += 1; set(primary, grown); closeInk(); }
    }

    /* Shrink: everything together, so the relationship between the headline and
       its lede survives the step. Two steps is the floor — a third would take a
       display line below the lede's own size and invert the hierarchy, and a
       plate that still does not fit at step 2 is a copy-length problem that the
       content-weight floor should refuse rather than something type can hide. */
    var step = 0;
    while (overflows() && step < 2) {
      step += 1;
      set(hosts, step);
      closeInk();
    }

    /* Leave the outcome on the body so a render check, the interest floor and a
       failing test can all see which rung was used without re-deriving it. */
    document.body.setAttribute('data-fit-step', String(step));
  }

  /* TWO PASSES, AND THE FLAG GOES UP AFTER THE SECOND. The first pass measures
     the fallback face; a web font with different metrics can turn a line that
     fitted into one that does not, so the answer is only true once the fonts
     the plate actually uses have loaded. `render-carousel.ts` waits on
     `__CAROUSEL_READY__`, so raising it before the second pass would screenshot
     a layout the ladder had not seen. */
  /* THE SHADE FOLLOWS THE WORDS (WS-08). After the last fit pass, so the
     lockup's top is where it will be screenshotted: the dense band of the
     scrim reaches one line (6% of the plate) above the first line of copy,
     and never drops below the 22% the stylesheet has always used. */
  function anchorScrim() {
    var scrim = document.querySelector('.scrim');
    var lock = plate.querySelector('.lockup, .sl-lockup');
    if (!scrim || !lock || getComputedStyle(scrim).display === 'none') return;
    var h = document.documentElement.clientHeight || window.innerHeight;
    if (!h) return;
    var fromBottom = ((h - lock.getBoundingClientRect().top) / h) * 100 + 6;
    var dense = Math.max(22, Math.min(80, fromBottom));
    document.body.style.setProperty('--scrim-dense', dense.toFixed(1) + '%');
    document.body.setAttribute('data-scrim-dense', dense.toFixed(0));
  }
  /* THE PICTURE TAKES THE AIR THE COPY LEFT (2026-09-25). A framed cover and an
     inset photo plate set the picture as a block of a FIXED height (540px,
     600px) and anchor the copy to the foot, so short copy left a dead band
     between the two: the owner's Kindly Yours slide 2 ("the picture takes a
     quarter at the top and the rest is empty") and the Karos cover of job
     PCjzJDH10gQW7peazB5n (a 330px empty band between the photograph and the
     title). After the ladder has sized the type, whatever the auto margin above
     the first block still holds is given to the picture, so the block reaches
     down to the copy. It only ever GROWS the picture into space that was empty,
     so it cannot push the copy into the foot band. */
  var FILL = [
    { pic: 'img.hero[data-kind="framed"]', prop: '--frame-h' },
    { pic: '.bg[data-kind="framed"] > img', prop: '--frame-h' },
    { pic: 'body[data-figure="inset"] .bg', prop: '--inset-h', needs: '.plate.slide' },
  ];
  /* The top and bottom of what a reader sees on the plate: visible runs of
     text and pictures/drawings, not the boxes that hold them. */
  function inkExtent() {
    var top = Infinity, bottom = -Infinity;
    var walker = document.createTreeWalker(plate, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    var range = document.createRange();
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      var rect = null;
      if (node.nodeType === 3) {
        if (!node.nodeValue || !node.nodeValue.trim()) continue;
        range.selectNodeContents(node);
        rect = range.getBoundingClientRect();
      } else if (/^(IMG|SVG|svg|CANVAS)$/.test(node.tagName)) {
        rect = node.getBoundingClientRect();
      } else continue;
      if (!rect || rect.width === 0 || rect.height === 0) continue;
      var el = node.nodeType === 3 ? node.parentElement : node;
      if (el && getComputedStyle(el).visibility === 'hidden') continue;
      if (rect.top < top) top = rect.top;
      if (rect.bottom > bottom) bottom = rect.bottom;
    }
    return top === Infinity ? null : { top: top, bottom: bottom };
  }
  function resetPicture() {
    document.body.style.removeProperty('--frame-h');
    document.body.style.removeProperty('--inset-h');
    document.body.removeAttribute('data-picture-filled');
  }
  function fillPicture() {
    for (var i = 0; i < FILL.length; i++) {
      var f = FILL[i];
      if (f.needs && !document.querySelector(f.needs)) continue;
      var pic = document.querySelector(f.pic);
      if (!pic || getComputedStyle(pic).display === 'none') continue;
      /* The slack is measured to the first INK, not to a box: the lockup is a
         flex item that stretches to the foot and anchors its copy inside
         itself, so its own top says nothing about where the words start.
         Ink is a visible run of text or a picture/drawing on the plate. */
      var start = plate.getBoundingClientRect().top + parseFloat(getComputedStyle(plate).paddingTop || '0');
      var ink = inkExtent();
      if (!ink) return;
      var free = Math.floor(ink.top - start);
      if (free < 24) return;
      var h = pic.getBoundingClientRect().height;
      /* Boxes with no ink above the words (an empty accent, an empty eyebrow)
         still take their height when the field shortens, so the words can move
         down by more than the gap closed. Whatever the ink then overshoots the
         field's foot by is given back, measured, twice at most. */
      var fieldBottom = function () { var r = plate.getBoundingClientRect(); return r.bottom - parseFloat(getComputedStyle(plate).paddingBottom || '0'); };
      var grow = free;
      for (var k = 0; k < 3 && grow >= 24; k++) {
        document.body.style.setProperty(f.prop, Math.round(h + grow) + 'px');
        var after = inkExtent();
        var over = after ? Math.ceil(after.bottom - fieldBottom()) : 0;
        if (over <= 0) break;
        grow -= over + 1;
      }
      if (grow < 24) { document.body.style.removeProperty(f.prop); return; }
      document.body.setAttribute('data-picture-filled', String(grow));
      return;
    }
  }
  pass();
  fillPicture();
  var done = function () { resetPicture(); pass(); fillPicture(); anchorScrim(); window.__CAROUSEL_READY__ = true; };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(done, done);
  else done();
})();
