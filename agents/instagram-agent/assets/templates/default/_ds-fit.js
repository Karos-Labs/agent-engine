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
    if (!overflows() && primary.length) {
      set(primary, -1);
      closeInk();
      if (overflows()) { set(primary, 0); closeInk(); }
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
  pass();
  var done = function () { pass(); window.__CAROUSEL_READY__ = true; };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(done, done);
  else done();
})();
