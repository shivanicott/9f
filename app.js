/* ==========================================================================
   9 Foundations — Data Centers page interactivity
   d3 + topojson loaded via CDN (defer). data.js exposes window.NINEF_DATA.
   ========================================================================== */

(function () {
  "use strict";

  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ----------------------------------------------------------- utilities */

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const fmt = {
    num:   n => Number(n).toLocaleString(),
    int:   n => Math.round(n).toLocaleString(),
    flt:   (n, d = 1) => Number(n).toFixed(d),
    money: n => "$" + Math.round(n).toLocaleString(),
  };

  function once(el, ev, fn) {
    el.addEventListener(ev, fn, { once: true });
  }

  // Seeded RNG (Mulberry32) — keeps animations reproducible.
  function rng(seed) {
    return function () {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ----------------------------------------------------------- topnav elevation + scroll progress */

  const nav = $(".topnav");
  const progressBar = (() => {
    if (!nav) return null;
    const el = document.createElement("div");
    el.className = "topnav__progress";
    nav.appendChild(el);
    return el;
  })();

  function onScroll() {
    if (!nav) return;
    nav.setAttribute("data-elev", window.scrollY > 12 ? "1" : "0");
    if (progressBar) {
      const doc = document.documentElement;
      const max = Math.max(1, (doc.scrollHeight || document.body.scrollHeight) - window.innerHeight);
      const pct = Math.min(1, Math.max(0, window.scrollY / max));
      progressBar.style.transform = `scaleX(${pct.toFixed(4)})`;
    }
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ----------------------------------------------------------- scroll-spy: active topnav link

     Position-based, not visibility-based. On every scroll we pick the
     section whose top has just passed the topnav line — meaning the
     active link is symmetric scrolling up vs down, and there is no
     dead zone between sections where nothing is highlighted. */

  (function scrollSpy() {
    const links = $$('.topnav__links a');
    if (!links.length) return;
    const linkByHash = new Map(links.map((a) => [a.getAttribute("href"), a]));
    const targets = links
      .map((a) => {
        const el = document.querySelector(a.getAttribute("href"));
        return el ? { el, link: a } : null;
      })
      .filter(Boolean);
    if (!targets.length) return;

    let currentActive = null;
    function updateActive() {
      // Anchor line just below the topnav — section is "active" once its
      // top has scrolled above this line. ~120px keeps the active link in
      // sync with what the user is actually reading.
      const anchorY = 120;
      let active = targets[0];
      for (const t of targets) {
        const top = t.el.getBoundingClientRect().top;
        if (top - anchorY <= 0) active = t;
        else break;
      }
      if (active === currentActive) return;
      currentActive = active;
      links.forEach((a) => a.classList.toggle("is-active", a === active.link));
    }
    updateActive();
    window.addEventListener("scroll", updateActive, { passive: true });
    window.addEventListener("resize", updateActive, { passive: true });
  })();

  /* ----------------------------------------------------------- scroll reveals + count-ups */

  // Decorate sections + cards with reveal hook.
  $$(".section__head, .card, .pillar, .chart, .hl__sensors, .hl__tiles, .hl__score, .mx__flow, .mx__panel, .map-shell, .hero__proof").forEach(el => el.setAttribute("data-reveal", ""));

  const revealIO = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add("is-in");
          revealIO.unobserve(e.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
  );
  $$("[data-reveal]").forEach((el) => revealIO.observe(el));

  function countUp(el) {
    const raw = el.dataset.countup;
    const target = parseFloat(raw);
    const suffix = el.dataset.suffix || "";
    const isNum = el.dataset.format === "num";
    // Preserve the decimal precision the author wrote (e.g. "2.83" stays
    // 2 decimals, "36.7" stays 1, "412" stays 0).
    const dotIdx = raw.indexOf(".");
    const decimals = dotIdx === -1 ? 0 : (raw.length - dotIdx - 1);
    const dur = 1500;
    const start = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    function fmtVal(v) {
      if (isNum) return fmt.int(v);
      if (decimals === 0) return Math.round(v).toString();
      return v.toFixed(decimals);
    }
    function tick(now) {
      const t = Math.min(1, (now - start) / dur);
      const v = target * ease(t);
      el.textContent = fmtVal(v) + suffix;
      if (t < 1) requestAnimationFrame(tick);
    }
    if (REDUCED) {
      el.textContent = fmtVal(target) + suffix;
    } else {
      requestAnimationFrame(tick);
    }
  }

  const countIO = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          countUp(e.target);
          countIO.unobserve(e.target);
        }
      });
    },
    { threshold: 0.4 }
  );
  $$("[data-countup]").forEach((el) => countIO.observe(el));

  /* Hero ambient canvas was removed during the branding visual-system pass.
     Drifting particles + connecting lines read as default AI polish; the
     hero now leans on a static technical grid + scale rule (SVG in HTML)
     to express building-science / measurement language without animation. */

  /* ============================================================ VIRGINIA MAP */

  (function vaMap() {
    if (typeof d3 === "undefined" || typeof topojson === "undefined") {
      console.warn("[9F] d3/topojson missing; map skipped");
      return;
    }
    const data = window.NINEF_DATA;
    if (!data) return;

    const svg = d3.select("#va-map");
    const canvas = $("#map-canvas");
    const loading = $("#map-loading");

    const W = 800, H = 500;
    svg.attr("viewBox", `0 0 ${W} ${H}`);

    // State of filters
    const filterState = { status: "all", system: "all" };
    let pointSel = null;

    // Fetch VA outline (FIPS 51) from us-atlas (primary), with a unpkg mirror
    // as a fallback if the primary CDN is blocked in production.
    function loadVA() {
      const urls = [
        "https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/states-10m.json",
        "https://unpkg.com/us-atlas@3.0.1/states-10m.json",
      ];
      return urls.reduce(
        (chain, url) => chain.catch(() => d3.json(url)),
        Promise.reject()
      );
    }
    loadVA()
      .then((us) => {
        const states = topojson.feature(us, us.objects.states);
        const va = states.features.find((f) => f.id === "51");
        if (!va) throw new Error("Virginia geometry not found in us-atlas");
        renderMap(va);
        loading && loading.classList.add("is-hidden");
      })
      .catch((err) => {
        console.error("[9F] map load failed", err);
        // Render points alone with a Mercator projection bounded to Virginia,
        // so the inventory stays meaningful even without the outline polygon.
        renderMap(null);
        if (loading) {
          loading.classList.add("is-hidden");
        }
        canvas && canvas.classList.add("is-degraded");
      });

    function renderMap(va) {
      // Project on Virginia bounds with padding. When the state outline is
      // unavailable (degraded fallback), use a hardcoded VA bounding box so
      // the points still register on the right physical geometry.
      let projection;
      if (va) {
        projection = d3.geoMercator().fitExtent([[24, 30], [W - 24, H - 30]], va);
      } else {
        const VA_BBOX = {
          type: "Polygon",
          coordinates: [[[-83.7, 36.5], [-75.2, 36.5], [-75.2, 39.5], [-83.7, 39.5], [-83.7, 36.5]]],
        };
        projection = d3.geoMercator().fitExtent([[24, 30], [W - 24, H - 30]], VA_BBOX);
      }
      const path = d3.geoPath(projection);

      // soft grid
      const grid = svg.append("g").attr("class", "va-grid");
      for (let i = 1; i < 16; i++) {
        grid.append("line").attr("x1", i * (W / 16)).attr("y1", 0).attr("x2", i * (W / 16)).attr("y2", H);
      }
      for (let i = 1; i < 10; i++) {
        grid.append("line").attr("x1", 0).attr("y1", i * (H / 10)).attr("x2", W).attr("y2", i * (H / 10));
      }

      // outline (only when geometry is available)
      if (va) {
        svg.append("path").datum(va).attr("class", "va-outline").attr("d", path);
      } else {
        // Degraded-state notice rendered into the map canvas
        const note = svg.append("g").attr("transform", `translate(${W - 18}, ${H - 14})`);
        note.append("text")
          .attr("text-anchor", "end")
          .attr("fill", "#5d6778")
          .style("font", "10px JetBrains Mono, monospace")
          .style("letter-spacing", "0.06em")
          .text("State outline unavailable · points geo-accurate");
      }

      // Point radius from IT load (log scale)
      const itExtent = d3.extent(data.sites, (d) => d.it_mw);
      const rScale = d3.scaleLog().domain([Math.max(0.05, itExtent[0]), itExtent[1]]).range([1.6, 5.2]).clamp(true);

      const points = svg.append("g").attr("class", "dc-dots");

      pointSel = points.selectAll("circle")
        .data(data.sites)
        .enter()
        .append("circle")
        .attr("class", (d) => `dc-dot dc-dot--${d.status}`)
        .attr("cx", (d) => projection([d.lng, d.lat])[0])
        .attr("cy", (d) => projection([d.lng, d.lat])[1])
        .attr("r", 0)
        .attr("opacity", 0)
        .style("filter", "none")
        // Two-tier interaction:
        //   hover / focus → PREVIEW: highlight the dot + update the inventory
        //     side panel only. Ephemeral. Lets users browse.
        //   click / Enter / Space → COMMIT: dispatches site:select so the
        //     archetype panel and both intent blocks rebind to this site.
        // The intent-block language ("Selected" / "Derived from") implies an
        // intentional choice — only the commit path should produce that state.
        .on("mouseenter", (event, d) => previewSite(d, event.currentTarget))
        .on("mouseleave", () => deactivate())
        .on("click",      (event, d) => commitSite(d, event.currentTarget))
        .on("focus",      (event, d) => previewSite(d, event.currentTarget))
        .on("blur",       () => deactivate())
        .on("keydown",    function (event, d) {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            commitSite(d, this);
          }
        })
        .attr("tabindex", 0)
        .attr("role", "button")
        .attr("aria-label", (d) => `${d.county} ${d.status} data center, ${d.it_mw} MW IT load — press Enter to select`);

      // staged reveal
      if (REDUCED) {
        pointSel.attr("r", (d) => rScale(Math.max(0.05, d.it_mw))).attr("opacity", 0.9);
      } else {
        pointSel.transition()
          .delay((_d, i) => 8 + (i * 4) % 1800)
          .duration(700)
          .ease(d3.easeCubicOut)
          .attr("r", (d) => rScale(Math.max(0.05, d.it_mw)))
          .attr("opacity", 0.92);
      }

      // Seed legend counts + "showing N of N" caption on first paint.
      // The right column starts empty (no committed site); a hover or
      // click paints the tracker lines.
      applyFilters();
    }

    // Single calculation path — applies the active filter state and
    // updates every readout that depends on it (legend counts, totals,
    // inventory distribution histograms).
    function applyFilters() {
      if (!pointSel) return;
      let existingVisible = 0, plannedVisible = 0;
      const visibleSites = [];
      pointSel.classed("is-faded", (d) => {
        const faded =
          (filterState.status !== "all" && d.status !== filterState.status);
        if (!faded) {
          if (d.status === "existing") existingVisible++;
          else if (d.status === "planned") plannedVisible++;
          visibleSites.push(d);
        }
        return faded;
      });
      const totalVisible = existingVisible + plannedVisible;
      const totalAll = data.sites.length;

      const $le = document.getElementById("legend-existing");
      const $lp = document.getElementById("legend-planned");
      if ($le) $le.textContent = existingVisible.toLocaleString();
      if ($lp) $lp.textContent = plannedVisible.toLocaleString();

      const $showing = document.getElementById("map-showing");
      if ($showing) {
        $showing.textContent = totalVisible === totalAll
          ? `Showing all ${totalAll.toLocaleString()} sites`
          : `Showing ${totalVisible.toLocaleString()} of ${totalAll.toLocaleString()} sites`;
      }

      // Update inventory distribution histograms with the same active set.
      renderHistograms(visibleSites);
    }

    // Inventory distribution histograms — show the SHAPE of the variation
    // across the active subset (cyan bars) against the full inventory
    // (faint ghost outline). Replaces the static range strip.
    function bins(arr, accessor, n, isLog) {
      const vals = arr.map(accessor).filter((v) => Number.isFinite(v));
      const allVals = data.sites.map(accessor).filter((v) => Number.isFinite(v));
      const dom = [Math.min(...allVals), Math.max(...allVals)];
      const scale = isLog
        ? (v) => (Math.log(Math.max(0.001, v)) - Math.log(Math.max(0.001, dom[0]))) / (Math.log(dom[1]) - Math.log(Math.max(0.001, dom[0])))
        : (v) => (v - dom[0]) / (dom[1] - dom[0]);
      const out = new Array(n).fill(0);
      vals.forEach((v) => {
        const t = Math.min(0.9999, Math.max(0, scale(v)));
        out[Math.floor(t * n)] += 1;
      });
      return out;
    }
    // Histogram drawing — the stacked variant uses a taller viewBox so
    // bars + a tracker line have room to breathe. The hist__track-line
    // and hist__track-dot persist across redraws (they're appended last
    // and toggled via the .is-on class from the dot-hover handler).
    const HIST_GEOM = {
      W: 320, H: 80,
      padL: 6, padR: 6, padT: 10, padB: 14,
    };
    function histDomain(accessor) {
      const allVals = data.sites.map(accessor).filter((v) => Number.isFinite(v));
      return [Math.min(...allVals), Math.max(...allVals)];
    }
    function drawHist(svgId, subset, accessor, isLog) {
      const svgNode = document.getElementById(svgId);
      if (!svgNode) return;
      while (svgNode.firstChild) svgNode.removeChild(svgNode.firstChild);
      const N = 32;
      const bActive = bins(subset, accessor, N, isLog);
      const bAll = bins(data.sites, accessor, N, isLog);
      const max = Math.max(1, ...bAll);
      const { W, H, padL, padR, padT, padB } = HIST_GEOM;
      const bw = (W - padL - padR) / N;
      const ns = "http://www.w3.org/2000/svg";
      function elN(tag, attrs) {
        const e = document.createElementNS(ns, tag);
        Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
        return e;
      }
      // baseline rule
      svgNode.appendChild(elN("line", {
        x1: padL, x2: W - padR, y1: H - padB, y2: H - padB, class: "bar-baseline"
      }));
      // ghost (full dataset)
      bAll.forEach((v, i) => {
        const h = (v / max) * (H - padT - padB);
        if (h <= 0) return;
        svgNode.appendChild(elN("rect", {
          class: "bar-ghost",
          x: (padL + i * bw + 0.5).toFixed(1),
          y: (H - padB - h).toFixed(1),
          width: Math.max(1, bw - 1).toFixed(1),
          height: h.toFixed(1),
        }));
      });
      // active subset
      bActive.forEach((v, i) => {
        const h = (v / max) * (H - padT - padB);
        if (h <= 0) return;
        svgNode.appendChild(elN("rect", {
          class: "bar-active",
          x: (padL + i * bw + 0.5).toFixed(1),
          y: (H - padB - h).toFixed(1),
          width: Math.max(1, bw - 1).toFixed(1),
          height: h.toFixed(1),
        }));
      });
      // Pinned-site primitives (persist between hovers, painted by
      // commitSite). Drawn BEHIND the transient hover tracker so an
      // active hover visually layers on top.
      svgNode.appendChild(elN("line", {
        class: "hist__pin-line",
        x1: padL, x2: padL, y1: padT, y2: H - padB,
      }));
      svgNode.appendChild(elN("circle", {
        class: "hist__pin-dot",
        cx: padL, cy: H - padB, r: 4.2,
      }));
      // Transient hover tracker — line + dot, appended once and
      // reused on hover. Cleared on mouseleave/deactivate.
      svgNode.appendChild(elN("line", {
        class: "hist__track-line",
        x1: padL, x2: padL, y1: padT, y2: H - padB,
      }));
      svgNode.appendChild(elN("circle", {
        class: "hist__track-dot",
        cx: padL, cy: H - padB, r: 3.4,
      }));
    }
    function renderHistograms(subset) {
      const set = subset && subset.length ? subset : data.sites;
      drawHist("hist-floor",   set, (d) => d.floor_m2, true);
      drawHist("hist-it",      set, (d) => d.it_mw,    true);
      drawHist("hist-pue",     set, (d) => d.pue,      false);
      drawHist("hist-filters", set, (d) => d.filters,  true);
    }

    // Tracker — given a site, paint a vertical line + dot on each
    // histogram at the site's value for that metric. Clearing the
    // tracker just toggles all four off.
    const HIST_TRACKERS = [
      { id: "hist-floor",   valEl: "hist-floor-val",   accessor: (d) => d.floor_m2, isLog: true,  fmt: (v) => `${Math.round(v).toLocaleString()} m²` },
      { id: "hist-it",      valEl: "hist-it-val",      accessor: (d) => d.it_mw,    isLog: true,  fmt: (v) => `${v.toFixed(2)} MW` },
      { id: "hist-pue",     valEl: "hist-pue-val",     accessor: (d) => d.pue,      isLog: false, fmt: (v) => v.toFixed(2) },
      { id: "hist-filters", valEl: "hist-filters-val", accessor: (d) => d.filters,  isLog: true,  fmt: (v) => Math.round(v).toLocaleString() },
    ];
    function setTrackers(site) {
      HIST_TRACKERS.forEach((cfg) => {
        const svgNode = document.getElementById(cfg.id);
        if (!svgNode) return;
        const line = svgNode.querySelector(".hist__track-line");
        const dot  = svgNode.querySelector(".hist__track-dot");
        const val  = document.getElementById(cfg.valEl);
        if (!site) {
          if (line) line.classList.remove("is-on");
          if (dot)  dot.classList.remove("is-on");
          if (val)  val.textContent = "—";
          return;
        }
        const v = cfg.accessor(site);
        if (!Number.isFinite(v)) {
          if (line) line.classList.remove("is-on");
          if (dot)  dot.classList.remove("is-on");
          if (val)  val.textContent = "—";
          return;
        }
        const [lo, hi] = histDomain(cfg.accessor);
        let t;
        if (cfg.isLog) {
          const loL = Math.log(Math.max(0.001, lo));
          const hiL = Math.log(Math.max(0.001, hi));
          t = (Math.log(Math.max(0.001, v)) - loL) / (hiL - loL);
        } else {
          t = (v - lo) / (hi - lo);
        }
        t = Math.min(0.999, Math.max(0, t));
        const { W, padL, padR, padT, H, padB } = HIST_GEOM;
        const x = padL + t * (W - padL - padR);
        if (line) {
          line.setAttribute("x1", x.toFixed(1));
          line.setAttribute("x2", x.toFixed(1));
          line.classList.add("is-on");
        }
        if (dot) {
          dot.setAttribute("cx", x.toFixed(1));
          // place dot near the top of the bar at that x position
          // (use a fixed mid-height for simplicity)
          dot.setAttribute("cy", (padT + (H - padT - padB) * 0.45).toFixed(1));
          dot.classList.add("is-on");
        }
        if (val) val.textContent = cfg.fmt(v);
      });
      const activeLbl = document.getElementById("hist-active");
      if (activeLbl) {
        if (site) {
          // PEC_ID intentionally omitted per Feedback 4 §2.3 — internal
          // site identifier, not user-meaningful on the map surface.
          activeLbl.textContent = `${site.county} County · ${site.status === "existing" ? "Existing" : "Planned"}`;
        } else {
          activeLbl.textContent = "— · click any site to commit";
        }
      }
    }

    // wire filter chips
    $$('.filters .chip').forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.filter;
        const val = btn.dataset.value;
        // toggle active siblings within same data-filter group
        $$(`.filters .chip[data-filter="${key}"]`).forEach((b) => {
          const on = b === btn;
          b.classList.toggle("is-active", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        });
        filterState[key] = val;
        applyFilters();
      });
    });

    // Hover preview drives the tracker lines on the right-column
    // distribution graphs; commit persists the selection until another
    // dot is clicked. The site-detail kv panel is gone — the graphs
    // ARE the readout now.
    let committedSite = null;
    function previewSite(d, node) {
      if (!pointSel) return;
      pointSel.classed("is-active", false);
      if (node) d3.select(node).classed("is-active", true);
      setTrackers(d);
    }
    function commitSite(d, node) {
      if (!pointSel) return;
      const target = node || pointSel.filter((p) => p.id === d.id).node();
      pointSel.classed("is-committed", false);
      pointSel.classed("is-active", false);
      if (target) {
        d3.select(target).classed("is-active", true).classed("is-committed", true);
      }
      committedSite = d;
      setTrackers(d);
      setPinMarkers(d);
      const statusLabel = d.status === "existing" ? "Existing" : "Planned";
      // PEC_ID omitted per Feedback 4 §2.3 — county leads instead.
      const summary = `<b>${d.county} County</b> · ${statusLabel} · ${d.system} · ${fmt.flt(d.it_mw, 1)} MW`;
      const intentMap = document.getElementById("intent-map");
      if (intentMap) intentMap.innerHTML = summary;
    }
    // Pin markers persist across hovers so the committed site stays
    // visible in every histogram while the user explores other dots.
    // Same metric resolution as setTrackers — different DOM nodes.
    function setPinMarkers(site) {
      HIST_TRACKERS.forEach((cfg) => {
        const svgNode = document.getElementById(cfg.id);
        if (!svgNode) return;
        const line = svgNode.querySelector(".hist__pin-line");
        const dot  = svgNode.querySelector(".hist__pin-dot");
        if (!site) {
          if (line) line.classList.remove("is-on");
          if (dot)  dot.classList.remove("is-on");
          return;
        }
        const v = cfg.accessor(site);
        if (!Number.isFinite(v)) return;
        const [lo, hi] = histDomain(cfg.accessor);
        let t;
        if (cfg.isLog) {
          const loL = Math.log(Math.max(0.001, lo));
          const hiL = Math.log(Math.max(0.001, hi));
          t = (Math.log(Math.max(0.001, v)) - loL) / (hiL - loL);
        } else {
          t = (v - lo) / (hi - lo);
        }
        t = Math.min(0.999, Math.max(0, t));
        const { W, padL, padR, padT, H, padB } = HIST_GEOM;
        const x = padL + t * (W - padL - padR);
        if (line) {
          line.setAttribute("x1", x.toFixed(1));
          line.setAttribute("x2", x.toFixed(1));
          line.classList.add("is-on");
        }
        if (dot) {
          dot.setAttribute("cx", x.toFixed(1));
          dot.setAttribute("cy", (padT + (H - padT - padB) * 0.45).toFixed(1));
          dot.classList.add("is-on");
        }
      });
    }
    function deactivate() {
      // On hover-out, fall back to the committed site (if any). Tracker
      // sticks to the committed record so the user keeps the position
      // markers on screen between hovers.
      if (!pointSel) return;
      pointSel.classed("is-active", function () { return d3.select(this).classed("is-committed"); });
      setTrackers(committedSite);
    }
  })();

  /* ============================================================ FILTERSTUDIO
     Slide-fidelity rebuild against UI mock.pdf:
       - Anonymous case studies (Data Center A / B) and filters (A / B)
       - No operating-year scrubber, no month state
       - Animated building figure on the LEFT (slide 4 for A, slide 10 for B)
       - Three deck-faithful graphs on the RIGHT:
           Pressure drop · slides 5 (A) / 11 (B)
           Indoor PM2.5  · slides 6 (A) / 12 (B)
           Energy use    · slides 7 (A) / 13 (B) — grouped recirc + vent
       - Top-right readouts source from slide 8 (A) / 14 (B) exactly
       - TBO compare zone retains the deck's 5-lane category stack
     One state object drives everything: { case, filter }.
     ================================================================ */

  (function filterStudio() {
    const ps = $("#fs-pressure");
    const pm = $("#fs-pm");
    const en = $("#fs-energy");
    const arch = $("#fs-arch");
    if (!ps || !pm || !en || !arch) return;

    const SVG_NS = "http://www.w3.org/2000/svg";
    function el(tag, attrs = {}) {
      const e = document.createElementNS(SVG_NS, tag);
      Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
      return e;
    }
    function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

    // ---------- Case + filter spec ----------
    // Feedback 3 reversal: Filter A = anonymized Camfil (higher pressure /
    // lower PM / higher energy / higher TBO cost), Filter B = anonymized
    // H&V (lower pressure / higher PM / lower energy / lower TBO cost).
    // Pressure dots and PM averages match Feedback 3 §02.4/02.7 exactly.
    // Energy splits (recirc + vent) match §02.8 verbatim. Cost values to
    // the cent match §02.10. Vendor names never appear in UI.
    const CASES = {
      A: {
        label: "Data Center A",
        short: "Data Center A",
        site: {
          descriptor: "Modeled Virginia data center · DLC archetype",
          totalVolume_m3: 743224,
          itCapacity_MW: 280,
          dailySchedule_h: 24,
          systemType: "Direct liquid cooling (DLC)",
          airFraction: "20% air cooling · 80% liquid cooling",
          systemCapacity: "113 m³/s ventilation · 487 m³/s recirculation",
          filterCount: "2,674 ventilation · 2,674 recirculation",
        },
        filters: {
          "A": { name: "Filter A", pressureEnd: 206, pmMean: 0.22, pm10Mean: 0.37, energyRecirc:  5066340, energyVent:  6773432, energyKwh: 11839772, energyCost: 2107479.40, dustHeld: 171 },
          // PM2.5 0.12 µg/m³ for DC-A Filter B — Feedback 4 §3.6
          // overrides the prior Feedback 3 §02.7 value of 0.25.
          "B": { name: "Filter B", pressureEnd: 131, pmMean: 0.20, pm10Mean: 0.36, energyRecirc:  3313464, energyVent:  4382655, energyKwh:  7696119, energyCost: 1369909.20, dustHeld: 177 },
        },
      },
      B: {
        label: "Data Center B",
        short: "Data Center B",
        site: {
          descriptor: "Modeled Virginia data center · DEC archetype",
          totalVolume_m3: 408773,
          itCapacity_MW: 222,
          dailySchedule_h: 24,
          systemType: "Direct evaporative cooling (DEC)",
          airFraction: "50% air cooling · 50% liquid cooling",
          systemCapacity: "600 m³/s ventilation · 600 m³/s recirculation",
          filterCount: "4,707 ventilation · 4,707 recirculation",
        },
        filters: {
          "A": { name: "Filter A", pressureEnd: 194, pmMean: 0.12, pm10Mean: 0.17, energyRecirc: 7696119, energyVent: 11532344, energyKwh: 19228463, energyCost: 3625704, dustHeld: 153 },
          "B": { name: "Filter B", pressureEnd: 124, pmMean: 0.11, pm10Mean: 0.17, energyRecirc:  5786576, energyVent: 7462642, energyKwh: 13249218, energyCost: 2358361, dustHeld: 157 },
        },
      },
    };

    // Co-benefit dollar scaling per MWh — derived from statewide totals
    // (412 sites · $2.83M climate · $369k health · 206,419 MWh saved).
/*     const COBENEFIT_PER_MWH = {
      climateDollars: (2.83e6 / 206419),  // ≈ $13.71 / MWh saved
      healthDollars: (3.69e5 / 206419),  // ≈ $1.79 / MWh saved
    }; */

    // ---------- State ----------
    // Default to single-filter mode (Filter A) per Feedback 3 §02.6/02.7
    // singular readout grammar — "[N] Pa at one year", "YY μg/m³ annual
    // average". Compare remains an opt-in via the chip control.
    const state = { case: "A", filter: "A" };

    // ---------- Formatters ----------
    const compactUSD = (v) => {
      const abs = Math.abs(v), sign = v < 0 ? "−" : "";
      if (abs >= 1e6) return sign + "$" + (abs / 1e6).toFixed(2) + "M";
      if (abs >= 1e3) return sign + "$" + Math.round(abs / 1e3) + "k";
      return sign + "$" + Math.round(abs);
    };
    const fmtUSDFull = (v) => "$" + Math.abs(Math.round(v)).toLocaleString();
    const fmtKwh    = (v) => v.toLocaleString() + " kWh/y";
    const fmtMWh    = (kwh) => (kwh / 1000).toFixed(0) + " MWh/y";

    function activeFilters() {
      return state.filter === "compare" ? ["A", "B"] : [state.filter];
    }

    // Filter color convention per Feedback 3 §02.6: A=blue, B=green.
    // Used by every chart, readout, archetype membrane, cost readout.
    const FILTER_COLORS = { "A": "#0A74D6", "B": "#7CB342" };

    // ---------- Series builders (full-year shapes — no month scrubber) ----------
    // Pressure builds dust mass on the filter over a 1-year operating
    // period. Endpoint dot lands at (filter.dustHeld grams, filter.pressureEnd Pa);
    // we sample from (0, startPa) to that endpoint along an accelerating curve.
    function pressureSeries(filter, opts = {}) {
      const startPa = 65;
      const xEnd = filter.dustHeld;
      const yEnd = filter.pressureEnd;
      const N = 60;
      const out = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        out.push({ x: t * xEnd, y: startPa + (yEnd - startPa) * Math.pow(t, 1.5) });
      }
      return out;
    }
    function pmSeries(filter, seed) {
      const r = rng(seed);
      const N = 240;
      const out = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const seasonal = Math.sin(t * Math.PI * 2 - Math.PI / 3) * 0.025;
        const noise = (r() - 0.5) * 0.045;
        // Conventional time-series orientation:
        // x = hours into the year (0..8760), y = PM level (μg/m³).
        const pm = Math.max(0, filter.pmMean + seasonal + noise);
        out.push({ x: t * 8760, y: pm });
      }
      return out;
    }

    // ---------- Chart drawing ----------
    // PAD.l widened from 42 → 56 to make room for the vertical-left
    // y-axis title (Feedback 4 §3.5).
    const PAD = { l: 56, r: 14, t: 14, b: 30 };
    // Generalized x/y scales over real (xMin..xMax) × (yMin..yMax) domains.
    // The PM chart inverts data orientation per Feedback 3 §02.7:
    // x = PM2.5 level (μg/m³), y = Time (hrs). The series builder above
    // already labels coords {x, y} so the same plotter works for both
    // pressure (x=g, y=Pa) and PM (x=μg/m³, y=hrs).
    function lineChart(svg, opts) {
      clear(svg);
      const rect = svg.getBoundingClientRect();
      const W = Math.max(360, Math.round(rect.width));
      const H = 150;
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("preserveAspectRatio", "none");
      const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
      const xMin = opts.xMin, xMax = opts.xMax;
      const yMin = opts.yMin, yMax = opts.yMax;
      const xS = (x) => PAD.l + ((x - xMin) / (xMax - xMin)) * iw;
      const yS = (y) => PAD.t + (1 - (y - yMin) / (yMax - yMin)) * ih;

      // Y-axis gridlines + tick labels
      const yTicks = opts.yTicks || 4;
      for (let i = 0; i <= yTicks; i++) {
        const v = yMin + (yMax - yMin) * (i / yTicks);
        const y = yS(v);
        svg.appendChild(el("line", { x1: PAD.l, x2: W - PAD.r, y1: y, y2: y, stroke: "rgba(178,204,238,0.06)", "stroke-width": 0.6 }));
        const t = el("text", { x: PAD.l - 6, y: y + 3, "text-anchor": "end", fill: "#5f6c80", "font-size": 8.5, "font-family": "JetBrains Mono" });
        t.textContent = opts.fmtY ? opts.fmtY(v) : Math.round(v);
        svg.appendChild(t);
      }
      // X-axis ticks + labels
      const xTicks = opts.xTicks || 4;
      for (let i = 0; i <= xTicks; i++) {
        const v = xMin + (xMax - xMin) * (i / xTicks);
        const x = xS(v);
        svg.appendChild(el("line", { x1: x, x2: x, y1: H - PAD.b, y2: H - PAD.b + 3, stroke: "rgba(178,204,238,0.18)" }));
        const tx = el("text", { x, y: H - PAD.b + 14, "text-anchor": "middle", fill: "#5f6c80", "font-size": 8.5, "font-family": "JetBrains Mono" });
        tx.textContent = opts.fmtX ? opts.fmtX(v) : Math.round(v);
        svg.appendChild(tx);
      }
      // Axis-title labels (slide-faithful: tucked under the tick row on x,
      // rotated on y near the top of the y-axis).
      if (opts.xLabel) {
        const t = el("text", { x: PAD.l + iw / 2, y: H - 2, "text-anchor": "middle", fill: "#95a3b8", "font-size": 9.5, "font-family": "JetBrains Mono", "letter-spacing": "0.06em" });
        t.textContent = opts.xLabel;
        svg.appendChild(t);
      }
      if (opts.yLabel) {
        // Feedback 4 §3.5: y-axis title to the LEFT of the y-axis,
        // rotated vertically. Centered on the plot area's vertical
        // midpoint, with text rotated -90° around that point.
        const labelX = 12;
        const labelY = PAD.t + ih / 2;
        const t = el("text", {
          x: labelX, y: labelY,
          "text-anchor": "middle",
          transform: `rotate(-90, ${labelX}, ${labelY})`,
          fill: "#95a3b8", "font-size": 9.5, "font-family": "JetBrains Mono",
          "letter-spacing": "0.06em",
        });
        t.textContent = opts.yLabel;
        svg.appendChild(t);
      }
      // Plot each series
      opts.series.forEach((s) => {
        const path = s.pts.map((p, i) => (i ? "L" : "M") + xS(p.x).toFixed(1) + "," + yS(p.y).toFixed(1)).join(" ");
        svg.appendChild(el("path", {
          d: path, fill: "none",
          stroke: s.color, "stroke-width": s.width || 1.8,
          "stroke-linecap": "round", "stroke-linejoin": "round",
          opacity: s.opacity || 0.95,
        }));
        if (s.dot) {
          const dx = xS(s.dot.x), dy = yS(s.dot.y);
          svg.appendChild(el("circle", { cx: dx, cy: dy, r: 4, fill: s.color, stroke: "#0a1422", "stroke-width": 1.3 }));
          if (s.dotLabel) {
            const tx = el("text", { x: dx + 7, y: dy - 4, fill: s.color, "font-size": 9, "font-family": "JetBrains Mono", "font-weight": 600 });
            tx.textContent = s.dotLabel;
            svg.appendChild(tx);
          }
        }
      });
    }

    // Grouped bar chart for Energy — Feedback 3 §02.8:
    // x = Filter (A and B groups), y = Annual fan energy (kWh/y).
    // Each filter group shows two bars: Recirculation + Ventilation. Recirc
    // is the saturated filter color, Vent is the same hue dimmed.
    function drawEnergyBars(svg) {
      clear(svg);
      const rect = svg.getBoundingClientRect();
      const W = Math.max(360, Math.round(rect.width));
      // Energy chart needs extra room below the x-axis for three text
      // rows (lane labels, "Filter A/B" group labels, "Filter" x-axis
      // title). H bumped from 150 → 180; the bottom band uses an
      // expanded PAD.b so the rows have non-overlapping baselines.
      const H = 180;
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("preserveAspectRatio", "none");
      const PAD_B_BOTTOM = 56; // local override; shared PAD.b=30 isn't enough here
      const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD_B_BOTTOM;
      const filters = activeFilters();
      const caseData = CASES[state.case];

      // Y-axis max across all visible bars
      const allVals = [];
      filters.forEach((fKey) => {
        const f = caseData.filters[fKey];
        allVals.push(f.energyRecirc, f.energyVent);
      });
      const yMax = Math.max(...allVals) * 1.22;
      const yS = (v) => PAD.t + (1 - v / yMax) * ih;
      const xAxisY = H - PAD_B_BOTTOM;

      // y gridlines + labels (5 ticks)
      const yTicks = 4;
      for (let i = 0; i <= yTicks; i++) {
        const v = (yMax * i) / yTicks;
        const y = yS(v);
        svg.appendChild(el("line", { x1: PAD.l, x2: W - PAD.r, y1: y, y2: y, stroke: "rgba(178,204,238,0.06)", "stroke-width": 0.6 }));
        const tx = el("text", { x: PAD.l - 6, y: y + 3, "text-anchor": "end", fill: "#5f6c80", "font-size": 8.5, "font-family": "JetBrains Mono" });
        tx.textContent = v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? Math.round(v / 1e3) + "K" : Math.round(v).toString();
        svg.appendChild(tx);
      }
      // y-axis label — vertical-left per Feedback 4 §3.5
      {
        const labelX = 12;
        const labelY = PAD.t + ih / 2;
        const yLbl = el("text", {
          x: labelX, y: labelY,
          "text-anchor": "middle",
          transform: `rotate(-90, ${labelX}, ${labelY})`,
          fill: "#95a3b8", "font-size": 9.5, "font-family": "JetBrains Mono",
          "letter-spacing": "0.06em",
        });
        yLbl.textContent = "Annual fan energy (kWh/y)";
        svg.appendChild(yLbl);
      }

      // Groups: one per active filter
      const groupW = iw / filters.length;
      filters.forEach((fKey, gi) => {
        const f = caseData.filters[fKey];
        const groupCx = PAD.l + (gi + 0.5) * groupW;
        const fill = FILTER_COLORS[fKey];
        const lanes = [
          { k: "Recirc", v: f.energyRecirc, fill: fill, opacity: 0.95 },
          { k: "Vent",   v: f.energyVent,   fill: fill, opacity: 0.55 },
        ];
        const barW = Math.min(44, (groupW * 0.34) / lanes.length);
        const gap = Math.max(3, barW * 0.18);
        lanes.forEach((lane, bi) => {
          const offset = (bi - (lanes.length - 1) / 2) * (barW + gap) - barW / 2;
          const x = groupCx + offset;
          const y = yS(lane.v);
          svg.appendChild(el("rect", {
            x: x.toFixed(1), y: y.toFixed(1),
            width: barW.toFixed(1),
            height: Math.max(0, xAxisY - y).toFixed(1),
            fill: lane.fill, opacity: lane.opacity,
          }));
          // Value label above bar
          const lbl = el("text", {
            x: (x + barW / 2).toFixed(1),
            y: (y - 4).toFixed(1),
            "text-anchor": "middle",
            fill: lane.fill,
            "font-size": 9,
            "font-family": "JetBrains Mono",
            "font-weight": 600,
          });
          lbl.textContent = lane.v.toLocaleString();
          svg.appendChild(lbl);
          // Lane tick label below bar (Recirc / Vent)
          const sub = el("text", {
            x: (x + barW / 2).toFixed(1),
            y: (xAxisY + 11).toFixed(1),
            "text-anchor": "middle",
            fill: "#5f6c80",
            "font-size": 8,
            "font-family": "JetBrains Mono",
            "letter-spacing": "0.08em",
          });
          sub.textContent = lane.k;
          svg.appendChild(sub);
        });
        // Group label = "Filter A" / "Filter B" — pushed to xAxisY+30
        // so it doesn't collide with the "Filter" axis title below.
        const gl = el("text", {
          x: groupCx, y: xAxisY + 30,
          "text-anchor": "middle",
          fill: fill,
          "font-size": 10,
          "font-family": "JetBrains Mono",
          "font-weight": 600,
          "letter-spacing": "0.08em",
        });
        gl.textContent = f.name;
        svg.appendChild(gl);
      });
      // x-axis title — "Filter" — sits below the group labels with a
      // comfortable gap (xAxisY+30 group baseline → xAxisY+48 x-title
      // baseline = ~18px separation, no overlap at 10pt / 9.5pt sizes).
      const xLbl = el("text", { x: PAD.l + iw / 2, y: xAxisY + 48, "text-anchor": "middle", fill: "#95a3b8", "font-size": 9.5, "font-family": "JetBrains Mono", "letter-spacing": "0.06em" });
      xLbl.textContent = "Filter";
      svg.appendChild(xLbl);
    }

    // ---------- Building animation per case ----------
    // The figure changes per case study (slide 4 vs slide 10) — both are
    // wireframe-style outline buildings with a labeled FILTER membrane,
    // outdoor-PM intake on the left, indoor air on the right. Particle
    // stream flows left to right; ~filter.pmMean drives pass-through.
    let archParticles = [];
    function buildArchetype() {
      clear(arch);
      const wire = "rgba(178,204,238,0.78)";
      const wireDim = "rgba(178,204,238,0.32)";
      if (state.case === "A") {
        // Slide 4: low-slung horizontal industrial massing with pitched
        // roof segments. Single floor, large fenestration band.
        arch.innerHTML = `
          <text x="14" y="22" fill="#FCBC7E" font-family="JetBrains Mono" font-size="9" letter-spacing="0.18em">OUTDOOR PM₂.₅</text>
          <text x="346" y="22" text-anchor="end" fill="#6BA6F1" font-family="JetBrains Mono" font-size="9" letter-spacing="0.18em">INDOOR HALL</text>

          <!-- Inflow arrow -->
          <g stroke="rgba(252,188,126,0.6)" stroke-width="1" fill="none">
            <line x1="14" y1="148" x2="70" y2="148"/>
            <polyline points="60,143 70,148 60,153"/>
          </g>

          <!-- Building wireframe — slide-4 silhouette (long, low, pitched roof) -->
          <g stroke="${wire}" stroke-width="1" fill="none">
            <!-- Front face -->
            <polyline points="80,238 80,98 124,76 180,76 236,76 292,76 320,98 320,238 80,238"/>
            <!-- Pitched roof segments -->
            <polyline points="80,98 124,76"/>
            <polyline points="124,76 124,98"/>
            <polyline points="180,76 180,98"/>
            <polyline points="236,76 236,98"/>
            <polyline points="292,76 292,98"/>
            <polyline points="292,76 320,98"/>
            <!-- Ground line -->
            <line x1="0" y1="238" x2="360" y2="238"/>
            <!-- Floor band / fenestration -->
            <line x1="80" y1="120" x2="320" y2="120"/>
            <line x1="80" y1="142" x2="320" y2="142"/>
            <line x1="80" y1="164" x2="320" y2="164"/>
            <line x1="80" y1="186" x2="320" y2="186"/>
            <line x1="80" y1="208" x2="320" y2="208"/>
          </g>
          <!-- Verticals (wall divisions) -->
          <g stroke="${wireDim}" stroke-width="0.6">
            <line x1="124" y1="98" x2="124" y2="238"/>
            <line x1="168" y1="98" x2="168" y2="238"/>
            <line x1="212" y1="98" x2="212" y2="238"/>
            <line x1="256" y1="98" x2="256" y2="238"/>
            <line x1="292" y1="98" x2="292" y2="238"/>
          </g>

          <!-- Filter membrane (slightly to the left of mid) -->
          <g id="fs-filter-grp">
            <line x1="100" y1="104" x2="100" y2="232" stroke="#0A74D6" stroke-width="1.6"/>
            <line x1="102" y1="104" x2="102" y2="232" stroke="rgba(10,116,214,0.5)" stroke-width="0.7"/>
            <text id="fs-filter-label" x="101" y="96" text-anchor="middle" fill="#0A74D6" font-family="JetBrains Mono" font-size="8.5" letter-spacing="0.12em" font-weight="600">FILTER</text>
          </g>

          <text x="14" y="260" fill="rgba(149,163,184,0.55)" font-family="JetBrains Mono" font-size="8" letter-spacing="0.14em">DATA CENTER A · DLC ARCHETYPE</text>
          <g id="fs-arch-particles"></g>
        `;
      } else {
        // Slide 10: taller, boxier, vertical-fin facade (warehouse mass).
        arch.innerHTML = `
          <text x="14" y="22" fill="#FCBC7E" font-family="JetBrains Mono" font-size="9" letter-spacing="0.18em">OUTDOOR PM₂.₅</text>
          <text x="346" y="22" text-anchor="end" fill="#6BA6F1" font-family="JetBrains Mono" font-size="9" letter-spacing="0.18em">INDOOR HALL</text>

          <g stroke="rgba(252,188,126,0.6)" stroke-width="1" fill="none">
            <line x1="14" y1="148" x2="70" y2="148"/>
            <polyline points="60,143 70,148 60,153"/>
          </g>

          <!-- Building wireframe — slide-10 silhouette (taller, boxy, vertical fins) -->
          <g stroke="${wire}" stroke-width="1" fill="none">
            <!-- Roof slab -->
            <polyline points="80,58 320,58"/>
            <line x1="80" y1="58" x2="320" y2="58"/>
            <line x1="74" y1="64" x2="326" y2="64"/>
            <line x1="80" y1="58" x2="74" y2="64"/>
            <line x1="320" y1="58" x2="326" y2="64"/>
            <!-- Front face -->
            <rect x="74" y="64" width="252" height="174"/>
            <!-- Ground -->
            <line x1="0" y1="238" x2="360" y2="238"/>
          </g>
          <!-- Vertical fin pattern (the slide-10 facade signature) -->
          <g stroke="${wireDim}" stroke-width="0.6">
            <line x1="92" y1="64"  x2="92" y2="238"/>
            <line x1="108" y1="64" x2="108" y2="238"/>
            <line x1="124" y1="64" x2="124" y2="238"/>
            <line x1="140" y1="64" x2="140" y2="238"/>
            <line x1="156" y1="64" x2="156" y2="238"/>
            <line x1="172" y1="64" x2="172" y2="238"/>
            <line x1="188" y1="64" x2="188" y2="238"/>
            <line x1="204" y1="64" x2="204" y2="238"/>
            <line x1="220" y1="64" x2="220" y2="238"/>
            <line x1="236" y1="64" x2="236" y2="238"/>
            <line x1="252" y1="64" x2="252" y2="238"/>
            <line x1="268" y1="64" x2="268" y2="238"/>
            <line x1="284" y1="64" x2="284" y2="238"/>
            <line x1="300" y1="64" x2="300" y2="238"/>
          </g>
          <!-- Horizontal floor lines -->
          <g stroke="${wireDim}" stroke-width="0.6">
            <line x1="74" y1="118" x2="326" y2="118"/>
            <line x1="74" y1="172" x2="326" y2="172"/>
          </g>

          <!-- Filter membrane -->
          <g id="fs-filter-grp">
            <line x1="100" y1="72" x2="100" y2="232" stroke="#0A74D6" stroke-width="1.6"/>
            <line x1="102" y1="72" x2="102" y2="232" stroke="rgba(10,116,214,0.5)" stroke-width="0.7"/>
            <text id="fs-filter-label" x="101" y="64" text-anchor="middle" fill="#0A74D6" font-family="JetBrains Mono" font-size="8.5" letter-spacing="0.12em" font-weight="600">FILTER</text>
          </g>

          <text x="14" y="260" fill="rgba(149,163,184,0.55)" font-family="JetBrains Mono" font-size="8" letter-spacing="0.14em">DATA CENTER B · DEC ARCHETYPE</text>
          <g id="fs-arch-particles"></g>
        `;
      }

      // Update filter label per active filter
      const label = arch.querySelector("#fs-filter-label");
      if (label) {
        const filters = activeFilters();
        label.textContent = filters.length === 1
          ? CASES[state.case].filters[filters[0]].name.toUpperCase()
          : "FILTER";
      }

      // Particle pool
      const group = arch.querySelector("#fs-arch-particles");
      archParticles = [];
      const N = REDUCED ? 14 : 32;
      const interiorTop = state.case === "A" ? 104 : 72;
      const interiorBot = 232;
      for (let i = 0; i < N; i++) {
        const c = document.createElementNS(SVG_NS, "circle");
        c.setAttribute("r", "1.2");
        c.setAttribute("fill", "#FCBC7E");
        c.setAttribute("opacity", "0.85");
        group.appendChild(c);
        archParticles.push({
          el: c,
          x: Math.random() * 60,
          y: interiorTop + Math.random() * (interiorBot - interiorTop),
          vx: 0.4 + Math.random() * 0.45,
          state: "outside",
          yRange: [interiorTop, interiorBot],
        });
      }
    }

    function archStep() {
      const filters = activeFilters();
      const passRates = filters.map((fKey) => {
        const f = CASES[state.case].filters[fKey];
        return Math.max(0.04, Math.min(0.4, f.pmMean / 0.9));
      });
      const passRate = passRates.reduce((a, b) => a + b, 0) / passRates.length;

      archParticles.forEach((p) => {
        if (p.state === "outside") {
          p.x += p.vx;
          if (p.x >= 100) {
            if (Math.random() < passRate) {
              p.state = "indoor";
              p.el.setAttribute("fill", "#6BA6F1");
            } else {
              p.state = "stopped";
              p.el.setAttribute("opacity", "0.2");
            }
          }
        } else if (p.state === "indoor") {
          p.x += p.vx * 0.7;
          if (p.x > 326) {
            p.x = -2 - Math.random() * 24;
            p.y = p.yRange[0] + Math.random() * (p.yRange[1] - p.yRange[0]);
            p.state = "outside";
            p.el.setAttribute("fill", "#FCBC7E");
            p.el.setAttribute("opacity", "0.85");
          }
        } else if (p.state === "stopped") {
          p.x += 0.1;
          let op = parseFloat(p.el.getAttribute("opacity")) - 0.012;
          if (op <= 0) {
            p.x = -2 - Math.random() * 24;
            p.y = p.yRange[0] + Math.random() * (p.yRange[1] - p.yRange[0]);
            p.state = "outside";
            p.el.setAttribute("fill", "#FCBC7E");
            p.el.setAttribute("opacity", "0.85");
            return;
          }
          p.el.setAttribute("opacity", op.toFixed(2));
        }
        p.el.setAttribute("cx", p.x.toFixed(1));
        p.el.setAttribute("cy", p.y.toFixed(1));
      });
      if (!REDUCED) requestAnimationFrame(archStep);
    }

    // ---------- Cost readout (top of section, replaces bottom TBO) ----------
    // Renders the case-study Total Co-Benefits of Ownership cost values
    // exactly per Feedback 3 §02.10. Filter A in blue, Filter B in green.
    // Reacts to state.filter: in single-filter mode, the selected side
    // is emphasized and the other dimmed; in compare mode both read equally.
    function renderCostReadout() {
      const c = CASES[state.case];
      const caseEl = document.getElementById("fs-cost-case");
      const aEl = document.getElementById("fs-cost-a");
      const bEl = document.getElementById("fs-cost-b");
      const aSide = document.querySelector('[data-fs-cost-filter="A"]');
      const bSide = document.querySelector('[data-fs-cost-filter="B"]');
      if (caseEl) caseEl.textContent = c.label;
      const fmt = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (aEl) aEl.textContent = fmt(c.filters.A.energyCost);
      if (bEl) bEl.textContent = fmt(c.filters.B.energyCost);
      // Active/dim class system reflects the filter chip selection
      const sel = state.filter; // "A" | "B" | "compare"
      if (aSide) {
        aSide.classList.toggle("is-active", sel === "A");
        aSide.classList.toggle("is-dim", sel === "B");
      }
      if (bSide) {
        bSide.classList.toggle("is-active", sel === "B");
        bSide.classList.toggle("is-dim", sel === "A");
      }
    }

    // ---------- Intent block + case header ----------
    function updateIntent() {
      const c = CASES[state.case];
      const filterLbl = state.filter === "compare"
        ? "Compare"
        : c.filters[state.filter].name;
      const viewing = document.getElementById("fs-viewing");
      if (viewing) viewing.textContent = `${c.short} · ${filterLbl}`;
    }
    function renderCaseHeader() {
      const c = CASES[state.case];
      const nameEl = document.getElementById("fs-case-name");
      if (nameEl) nameEl.textContent = c.label;
      const site = document.getElementById("fs-site");
      if (!site) return;
      const s = c.site;
      site.innerHTML = `
        <div class="fs__site-head">
          <span class="fs__site-title">Site Characteristics</span>
          <span class="fs__site-addr">${s.descriptor}</span>
        </div>
        <div class="fs__site-col">
          <div class="fs__site-row"><dt>Total Building Volume</dt><dd>${s.totalVolume_m3.toLocaleString()} m³</dd></div>
          <div class="fs__site-row"><dt>Total IT Capacity</dt><dd>${s.itCapacity_MW} MW</dd></div>
          <div class="fs__site-row"><dt>Daily Operating Schedule</dt><dd>${s.dailySchedule_h} h</dd></div>
        </div>
        <div class="fs__site-col">
          <div class="fs__site-row"><dt>System Type</dt><dd>${s.systemType}</dd></div>
          <div class="fs__site-row"><dt>Air Fraction</dt><dd>${s.airFraction}</dd></div>
          <div class="fs__site-row"><dt>Number of Filters</dt><dd>${s.filterCount}</dd></div>
        </div>
      `;
    }

    // ---------- Chart readouts ----------
    // Top-left lead readouts use the exact singular grammar Feedback 3
    // §02.6/02.7 specified ("[N] Pa at one year", "YY μg/m³ annual
    // average"). Even in compare mode the phrase stays singular; the
    // two values fuse as "A=NN / B=MM" so the sentence still reads as
    // a single metric statement. Top-right boxed stats keep A blue /
    // B green per §02.9. Per Feedback 4 §3.3 the chart subtitle leads
    // ("N Pa at one year", "YY μg/m³ annual average", "N kWh/y total")
    // were removed from the UI; only the top-right boxed stats remain.
    function updateReadouts() {
      const c = CASES[state.case];
      const FA = c.filters["A"], FB = c.filters["B"];
      const setHTML = (id, val) => { const e = document.getElementById(id); if (e) e.innerHTML = val; };

      const aSpan = (txt) => `<span class="fs__readout-a">${txt}</span>`;
      const bSpan = (txt) => `<span class="fs__readout-b">${txt}</span>`;

      if (state.filter === "compare") {
        setHTML("fs-pressure-readout", `<span class="fs__readout-row">${aSpan("A <b>" + FA.pressureEnd.toFixed(0) + "</b>")} · ${bSpan("B <b>" + FB.pressureEnd.toFixed(0) + "</b>")} Pa</span>`);
        setHTML("fs-pm-readout",       `<span class="fs__readout-row">${aSpan("A <b>" + FA.pmMean.toFixed(2) + "</b>")} · ${bSpan("B <b>" + FB.pmMean.toFixed(2) + "</b>")} µg/m³</span>`);
        setHTML("fs-energy-readout",   `<span class="fs__readout-row">${aSpan("A <b>" + (FA.energyKwh/1000).toFixed(0) + "</b>")} · ${bSpan("B <b>" + (FB.energyKwh/1000).toFixed(0) + "</b>")} MWh/y</span>`);
      } else {
        const isA = state.filter === "A";
        const f  = isA ? FA : FB;
        const wrap = isA ? aSpan : bSpan;
        setHTML("fs-pressure-readout", wrap(`<b>${f.pressureEnd.toFixed(0)}</b> Pa`));
        setHTML("fs-pm-readout",       wrap(`<b>${f.pmMean.toFixed(2)}</b> µg/m³`));
        setHTML("fs-energy-readout",   wrap(`<b>${f.energyKwh.toLocaleString()}</b> kWh/y`));
      }
    }

    function redraw() {
      const caseData = CASES[state.case];
      const filters = activeFilters();

      // Pressure chart — dust feed (g) → pressure drop (Pa). Endpoint dots
      // land exactly on (dustHeld, pressureEnd) per Feedback 3 §02.4.
      const pressureSets = filters.map((fKey) => {
        const f = caseData.filters[fKey];
        const pts = pressureSeries(f);
        return {
          pts,
          color: FILTER_COLORS[fKey],
          dot: { x: f.dustHeld, y: f.pressureEnd },
          // Feedback 4 §3.4: complete label with units + closing parenthesis.
          dotLabel: `(${f.dustHeld.toFixed(2)} g, ${f.pressureEnd.toFixed(2)} Pa)`,
        };
      });
      const allPa = pressureSets.flatMap((s) => s.pts.map((p) => p.y)).concat([0]);
      const allG  = pressureSets.flatMap((s) => s.pts.map((p) => p.x));
      const xMax = Math.max(...allG, 1) * 1.12;
      const yMax = Math.max(...allPa) * 1.15;
      lineChart(ps, {
        series: pressureSets,
        xMin: 0, xMax,
        yMin: 0, yMax,
        xTicks: 5, yTicks: 4,
        fmtX: (v) => Math.round(v) + "g",
        fmtY: (v) => Math.round(v),
        xLabel: "Dust feed (g)",
        yLabel: "Pressure drop (Pa)",
      });

      // PM2.5 chart — conventional time-series orientation:
      // x = Time (hrs), y = PM2.5 level (μg/m³).
      const pmSets = filters.map((fKey) => ({
        pts: pmSeries(caseData.filters[fKey], fKey === "A" ? 91 : 113),
        color: FILTER_COLORS[fKey],
        width: 1.0, opacity: 0.78,
      }));
      const pmVals = pmSets.flatMap((s) => s.pts.map((p) => p.y));
      const pmYMax = Math.max(...pmVals) * 1.12;
      lineChart(pm, {
        series: pmSets,
        xMin: 0, xMax: 8760,
        yMin: 0, yMax: pmYMax,
        xTicks: 4, yTicks: 4,
        fmtX: (v) => v >= 1000 ? (v / 1000).toFixed(1) + "K" : Math.round(v),
        fmtY: (v) => v.toFixed(2),
        xLabel: "Time (hrs)",
        yLabel: "PM2.5 level (μg/m³)",
      });

      // Energy bars — Feedback 3 §02.8 (x=Filter, y=Annual fan energy)
      drawEnergyBars(en);

      updateReadouts();
    }

    // ---------- Controls ----------
    $$('[data-fs-case]').forEach((btn) => {
      btn.addEventListener("click", () => {
        $$('[data-fs-case]').forEach((b) => {
          const on = b === btn;
          b.classList.toggle("is-active", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        });
        state.case = btn.dataset.fsCase;
        renderCaseHeader();
        renderCostReadout();
        buildArchetype();
        updateIntent();
        redraw();
      });
    });
    $$('[data-fs-filter]').forEach((btn) => {
      btn.addEventListener("click", () => {
        $$('[data-fs-filter]').forEach((b) => {
          const on = b === btn;
          b.classList.toggle("is-active", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        });
        state.filter = btn.dataset.fsFilter;
        // Update filter-membrane label
        const label = arch.querySelector("#fs-filter-label");
        if (label) {
          const filters = activeFilters();
          label.textContent = filters.length === 1
            ? CASES[state.case].filters[filters[0]].name.toUpperCase()
            : "FILTER";
        }
        renderCostReadout();
        updateIntent();
        redraw();
      });
    });

    // ---------- ResizeObserver ----------
    if (typeof ResizeObserver !== "undefined") {
      let raf = 0;
      const ro = new ResizeObserver(() => {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => { raf = 0; redraw(); });
      });
      ro.observe(ps);
    }

    // ---------- Initial render ----------
    buildArchetype();
    renderCaseHeader();
    renderCostReadout();
    updateIntent();
    redraw();
    if (!REDUCED) requestAnimationFrame(archStep);
  })();

  /* ============================================================ MATRIX
     Functional rebuild of the platform matrix per Feedback 3 §03 (P1).
     The matrix grid is real HTML — every cell has its energy-reduction
     value (read off the screenshots, identical across all 49 scenarios)
     and a green gradient color. Hovering a cell swaps the image-backed
     Healthy People panel on the right (cropped from each scenario
     screenshot) so the bin distribution, building tilt, and offsets
     all come from authentic platform output, not freehand mockups.
     Cell → image mapping derived from the in-image scenario labels:
     panel index = (6 − row) × 7 + col, with row 0 = +7°F summer
     setback at the top and col 0 = no winter setback on the left.
     The bottom-left BASELINE cell maps to panel 00. */

  (function matrixPlatform() {
    const root = document.getElementById("mxp");
    const grid = document.getElementById("mxp-grid");
    const panel = document.getElementById("mxp-panel");
    const readout = document.getElementById("mxp-readout");
    const ppTower = document.getElementById("mxp-pp-tower");
    const ppBins = document.getElementById("mxp-pp-bins");
    const ppScenarioLbl = document.getElementById("mxp-pp-scenario");
    if (!root || !grid || !panel) return;

    // ---------- 49 scenario data payloads ----------
    // Values transcribed from the 49 source MATRIX platform screenshots
    // (one per cell). Each entry: { l: scenario label, b: bin %s,
    // d: offset Δ values }. b/d arrays in order H/E/A/A/L.
    const SCENARIOS = [
      { l: "Baseline",          b: [79.3,14.5,3.2,1.0,2.0], d: [0,0,0,0,0] },
      { l: "W −2°F / S 0",      b: [67.6,21.6,6.1,1.5,3.2], d: [-11.70,7.12,2.93,0.51,1.15] },
      { l: "W −3°F / S 0",      b: [62.3,22.3,8.0,3.1,4.3], d: [-16.92,7.76,4.83,2.04,2.29] },
      { l: "W −4°F / S 0",      b: [59.2,22.9,9.2,3.7,5.1], d: [-20.10,8.40,5.98,2.67,3.05] },
      { l: "W −5°F / S 0",      b: [54.2,19.7,8.8,5.2,12.1], d: [-25.06,5.22,5.60,4.20,10.05] },
      { l: "W −6°F / S 0",      b: [53.6,16.8,8.9,5.7,15.0], d: [-25.70,2.29,5.73,4.71,12.98] },
      { l: "W −7°F / S 0",      b: [52.7,16.2,7.5,5.3,18.3], d: [-26.59,1.65,4.33,4.33,16.28] },
      { l: "W 0 / S +2°F",      b: [79.4,14.4,3.1,1.1,2.0], d: [0.13,-0.13,-0.13,0.13,0] },
      { l: "W −2°F / S +2°F",   b: [67.7,21.5,6.0,1.7,3.2], d: [-11.58,7.00,2.80,0.64,1.15] },
      { l: "W −3°F / S +2°F",   b: [62.5,22.1,7.9,3.2,4.3], d: [-16.79,7.63,4.71,2.16,2.29] },
      { l: "W −4°F / S +2°F",   b: [59.3,22.8,9.0,3.8,5.1], d: [-19.97,8.27,5.85,2.80,3.05] },
      { l: "W −5°F / S +2°F",   b: [54.3,19.6,8.7,5.3,12.1], d: [-24.94,5.09,5.47,4.33,10.05] },
      { l: "W −6°F / S +2°F",   b: [53.7,16.7,8.8,5.9,15.0], d: [-25.57,2.16,5.60,4.83,12.98] },
      { l: "W −7°F / S +2°F",   b: [52.8,16.0,7.4,5.5,18.3], d: [-26.46,1.53,4.20,4.45,16.28] },
      { l: "W 0 / S +3°F",      b: [79.3,14.6,2.9,1.1,2.0], d: [0,0.13,-0.25,0.13,0] },
      { l: "W −2°F / S +3°F",   b: [67.6,21.8,5.9,1.7,3.2], d: [-11.70,7.25,2.67,0.64,1.15] },
      { l: "W −3°F / S +3°F",   b: [62.3,22.4,7.8,3.2,4.3], d: [-16.92,7.89,4.58,2.16,2.29] },
      { l: "W −4°F / S +3°F",   b: [59.2,23.0,8.9,3.8,5.1], d: [-20.10,8.52,5.73,2.80,3.05] },
      { l: "W −5°F / S +3°F",   b: [54.2,19.8,8.5,5.3,12.1], d: [-25.06,5.34,5.34,4.33,10.05] },
      { l: "W −6°F / S +3°F",   b: [53.6,16.9,8.7,5.9,15.0], d: [-25.70,2.42,5.47,4.83,12.98] },
      { l: "W −7°F / S +3°F",   b: [52.7,16.3,7.3,5.5,18.3], d: [-26.59,1.78,4.07,4.45,16.28] },
      { l: "W 0 / S +4°F",      b: [79.0,15.0,2.8,1.1,2.0], d: [-0.25,0.51,-0.38,0.13,0] },
      { l: "W −2°F / S +4°F",   b: [67.3,22.1,5.7,1.7,3.2], d: [-11.96,7.63,2.54,0.64,1.15] },
      { l: "W −3°F / S +4°F",   b: [62.1,22.8,7.6,3.2,4.3], d: [-17.18,8.27,4.45,2.16,2.29] },
      { l: "W −4°F / S +4°F",   b: [58.9,23.4,8.8,3.8,5.1], d: [-20.36,8.91,5.60,2.80,3.05] },
      { l: "W −5°F / S +4°F",   b: [53.9,20.2,8.4,5.3,12.1], d: [-25.32,5.73,5.22,4.33,10.05] },
      { l: "W −6°F / S +4°F",   b: [53.3,17.3,8.5,5.9,15.0], d: [-25.95,2.80,5.34,4.83,12.98] },
      { l: "W −7°F / S +4°F",   b: [52.4,16.7,7.1,5.5,18.3], d: [-26.84,2.16,3.94,4.45,16.28] },
      { l: "W 0 / S +5°F",      b: [78.9,15.0,2.9,1.1,2.0], d: [-0.38,0.51,-0.25,0.13,0] },
      { l: "W −2°F / S +5°F",   b: [67.2,22.1,5.9,1.7,3.2], d: [-12.09,7.63,2.67,0.64,1.15] },
      { l: "W −3°F / S +5°F",   b: [62.0,22.8,7.8,3.2,4.3], d: [-17.30,8.27,4.58,2.16,2.29] },
      { l: "W −4°F / S +5°F",   b: [58.8,23.4,8.9,3.8,5.1], d: [-20.48,8.91,5.73,2.80,3.05] },
      { l: "W −5°F / S +5°F",   b: [53.8,20.2,8.5,5.3,12.1], d: [-25.45,5.73,5.34,4.33,10.05] },
      { l: "W −6°F / S +5°F",   b: [53.2,17.3,8.7,5.9,15.0], d: [-26.08,2.80,5.47,4.83,12.98] },
      { l: "W −7°F / S +5°F",   b: [52.3,16.7,7.3,5.5,18.3], d: [-26.97,2.16,4.07,4.45,16.28] },
      { l: "W 0 / S +6°F",      b: [78.8,15.1,2.9,1.1,2.0], d: [-0.51,0.64,-0.25,0.13,0] },
      { l: "W −2°F / S +6°F",   b: [67.0,22.3,5.9,1.7,3.2], d: [-12.21,7.76,2.67,0.64,1.15] },
      { l: "W −3°F / S +6°F",   b: [61.8,22.9,7.8,3.2,4.3], d: [-17.43,8.40,4.58,2.16,2.29] },
      { l: "W −4°F / S +6°F",   b: [58.7,23.5,8.9,3.8,5.1], d: [-20.61,9.03,5.73,2.80,3.05] },
      { l: "W −5°F / S +6°F",   b: [53.7,20.4,8.5,5.3,12.1], d: [-25.57,5.85,5.34,4.33,10.05] },
      { l: "W −6°F / S +6°F",   b: [53.1,17.4,8.7,5.9,15.0], d: [-26.21,2.93,5.47,4.83,12.98] },
      { l: "W −7°F / S +6°F",   b: [52.2,16.8,7.3,5.5,18.3], d: [-27.10,2.29,4.07,4.45,16.28] },
      { l: "W 0 / S +7°F",      b: [78.6,15.3,2.8,1.3,2.0], d: [-0.64,0.76,-0.38,0.25,0] },
      { l: "W −2°F / S +7°F",   b: [66.9,22.4,5.7,1.8,3.2], d: [-12.34,7.89,2.54,0.76,1.15] },
      { l: "W −3°F / S +7°F",   b: [61.7,23.0,7.6,3.3,4.3], d: [-17.56,8.52,4.45,2.29,2.29] },
      { l: "W −4°F / S +7°F",   b: [58.5,23.7,8.8,3.9,5.1], d: [-20.74,9.16,5.60,2.93,3.05] },
      { l: "W −5°F / S +7°F",   b: [53.6,20.5,8.4,5.5,12.1], d: [-25.70,5.98,5.22,4.45,10.05] },
      { l: "W −6°F / S +7°F",   b: [52.9,17.6,8.5,6.0,15.0], d: [-26.34,3.05,5.34,4.96,12.98] },
      { l: "W −7°F / S +7°F",   b: [52.0,16.9,7.1,5.6,18.3], d: [-27.23,2.42,3.94,4.58,16.28] },
    ];

    // Bin metadata — letter, label, badge color (match HEAAL palette
    // and the source platform). Order H/E/A/A/L top→bottom.
    const PP_BINS = [
      { letter: "H", label: "Health Optimized", color: "#3F8FE6" },
      { letter: "E", label: "Excellent",        color: "#B2CCEE" },
      { letter: "A", label: "Action",           color: "#E2C75E" },
      { letter: "A", label: "Alert",            color: "#FCBC7E" },
      { letter: "L", label: "Limit",            color: "#E47A6A" },
    ];

    const NS_SVG = "http://www.w3.org/2000/svg";
    const svgEl = (tag, attrs) => {
      const el = document.createElementNS(NS_SVG, tag);
      if (attrs) Object.entries(attrs).forEach(([k,v]) => el.setAttribute(k, v));
      return el;
    };
    const clearNode = (n) => { while (n.firstChild) n.removeChild(n.firstChild); };

    // ---------- Tower SVG (live: each segment is a 0-100% bar) ----------
    // Each segment is a horizontal bar that fills left→right in
    // proportion to the bin's percentage. Redraws on every scenario
    // change so the tower reflects the active state.
    function drawPpTower(bins) {
      if (!ppTower) return;
      clearNode(ppTower);
      const W = 110, H = 320;
      ppTower.setAttribute("viewBox", `0 0 ${W} ${H}`);
      const xL = 16, xR = 88;
      const skew = 9;
      const segH = 56;
      const startY = 14;
      const interior = xR - xL;

      PP_BINS.forEach((bin, i) => {
        const y = startY + i * segH;
        const pct = Math.max(0, Math.min(100, bins[i] || 0));
        const fillW = (pct / 100) * interior;
        const bodyY = y + skew;
        const bodyH = segH - skew - 2;

        // Dark base for the empty portion of the bar
        ppTower.appendChild(svgEl("rect", {
          x: xL, y: bodyY, width: interior, height: bodyH,
          fill: "rgba(178,204,238,0.04)",
        }));
        // Bin-colored fill (proportional, left-anchored)
        if (fillW > 0.5) {
          ppTower.appendChild(svgEl("rect", {
            x: xL, y: bodyY, width: fillW, height: bodyH,
            fill: bin.color, opacity: 0.92,
          }));
        }
        // Body outline
        ppTower.appendChild(svgEl("rect", {
          x: xL, y: bodyY, width: interior, height: bodyH,
          fill: "none", stroke: "rgba(178,204,238,0.6)", "stroke-width": 1,
        }));
        // Iso roof slab
        ppTower.appendChild(svgEl("polygon", {
          points: `${xL},${bodyY} ${xR},${bodyY} ${xR + skew},${y} ${xL - skew},${y}`,
          fill: "rgba(178,204,238,0.05)",
          stroke: "rgba(178,204,238,0.6)", "stroke-width": 1,
        }));
        // Iso right side
        ppTower.appendChild(svgEl("polygon", {
          points: `${xR},${bodyY} ${xR + skew},${y} ${xR + skew},${y + segH - 2 - skew} ${xR},${y + segH - 2}`,
          fill: "rgba(0,0,0,0.22)",
          stroke: "rgba(178,204,238,0.6)", "stroke-width": 1,
        }));
      });
      // Base platform
      const baseY = startY + PP_BINS.length * segH;
      ppTower.appendChild(svgEl("polygon", {
        points: `${xL-5},${baseY+skew} ${xR+5},${baseY+skew} ${xR + skew + 5},${baseY} ${xL - skew - 5},${baseY}`,
        fill: "rgba(178,204,238,0.05)",
        stroke: "rgba(178,204,238,0.4)", "stroke-width": 1,
      }));
    }

    // ---------- Bin rows render ----------
    function fmtDelta(d) {
      if (Math.abs(d) < 0.005) return "0.00%";
      const sign = d > 0 ? "+" : "−";
      return sign + Math.abs(d).toFixed(2) + "%";
    }
    // Map an absolute delta magnitude to an opacity in [0.30, 1.0].
    // Zero/near-zero deltas read as muted gray; large deltas read at
    // full bin color. Makes the panel visibly change as you traverse
    // the matrix (BASELINE → severe), matching how the source platform
    // de-emphasizes near-zero offsets.
    function deltaOpacity(abs) {
      if (abs < 0.05) return 0.30;
      if (abs < 0.5)  return 0.50;
      if (abs < 2)    return 0.75;
      if (abs < 8)    return 0.92;
      return 1.0;
    }
    function renderPpBins(scenario) {
      if (!ppBins) return;
      // Header row labels the two signals:
      //   "Distribution"  → bar length / bin %s reflect current state
      //   "Offset Δ"      → shift from baseline
      const head = `
        <li class="mxp__pp-bin mxp__pp-bin--head" aria-hidden="true">
          <span></span>
          <span class="mxp__pp-bin-head-l">Distribution</span>
          <span class="mxp__pp-bin-head-r">Offset Δ</span>
        </li>`;
      const rows = PP_BINS.map((b, i) => {
        const d = scenario.d[i];
        const abs = Math.abs(d);
        const op = deltaOpacity(abs);
        const isZero = abs < 0.005;
        return `
        <li class="mxp__pp-bin" data-bin="${i}" data-zero="${isZero}">
          <span class="mxp__pp-bin-badge" style="background:${b.color}">${b.letter}</span>
          <span class="mxp__pp-bin-meta">
            <span class="mxp__pp-bin-v">${scenario.b[i].toFixed(1)}%</span>
            <span class="mxp__pp-bin-k">${b.label}</span>
          </span>
          <span class="mxp__pp-bin-d" style="opacity:${op.toFixed(2)}">${fmtDelta(d)}</span>
        </li>`;
      }).join("");
      ppBins.innerHTML = head + rows;
    }

    // Occupancy slice state — a real panel lens, independent from the
    // active scenario. The Healthy People panel render is now a pure
    // function of (scenario, occupancySlice).
    //
    // Data inventory: all 49 source screenshots were captured with
    // Monday selected, so the "monday" slice has real measured values
    // for every scenario. No screenshots exist for "all" (All Occupied
    // Hours), so that slice has no data. Per the brief's truthfulness
    // rule we don't fabricate "all" values — instead the All Occupied
    // Hours button is disabled in markup with an explanatory title.
    // When real all-occupied data becomes available, drop it into
    // SCENARIO_SLICES.all (same shape as .monday) and remove the
    // disabled attribute. No render code changes needed.
    const SCENARIO_SLICES = {
      monday: SCENARIOS,
      all: null, // not captured in source data
    };
    let occupancySlice = "monday";
    let currentScenarioIdx = 0;
    let currentReadoutR = 6;
    let currentReadoutC = 0;

    function renderPpScenario(idx) {
      currentScenarioIdx = idx;
      const dataset = SCENARIO_SLICES[occupancySlice];
      if (!dataset) return; // safety: button should be disabled
      const s = dataset[idx] || dataset[0];
      if (ppScenarioLbl) ppScenarioLbl.textContent = formatScenarioLabel(s.l);
      drawPpTower(s.b);
      renderPpBins(s);
    }

    // Real click handler for the occupancy controls (not in wireGroup —
    // this drives real state + a re-render of the panel, scenario stays
    // fixed). All Occupied Hours is disabled; clicking is a no-op via
    // the disabled attribute. Monday is permanently selected but the
    // click handler is wired so the interaction model is consistent
    // and so future "all" slice activation needs no additional wiring.
    function setOccupancy(slice) {
      if (!SCENARIO_SLICES[slice]) return; // refuse to set a sliceless lens
      occupancySlice = slice;
      root.querySelectorAll('[data-mxp-occ]').forEach((btn) => {
        const on = btn.dataset.mxpOcc === slice;
        btn.classList.toggle("is-active", on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
      });
      renderPpScenario(currentScenarioIdx);
    }
    root.querySelectorAll('[data-mxp-occ]').forEach((btn) => {
      btn.addEventListener("click", () => setOccupancy(btn.dataset.mxpOcc));
    });

    const ROWS = 7, COLS = 7;
    // Row labels (top → bottom): +7°F .. +2°F, then 0 (BASELINE row).
    // Stored in °F as the canonical source; converted at render time
    // via formatOffset(unit). Same pattern for columns.
    const ROW_LBLS_F = ["+7°F", "+6°F", "+5°F", "+4°F", "+3°F", "+2°F", "0"];
    const COL_LBLS_F = ["0", "−2°F", "−3°F", "−4°F", "−5°F", "−6°F", "−7°F"];
    // Cell %-reduction values read directly off the platform screenshots.
    // Format: [low, high] per cell, row-major top-to-bottom. The BASELINE
    // cell (row 6, col 0) is rendered as a literal "BASELINE" label.
    const CELLS = [
      // Row +7°F
      [[1.1,1.2],[3.3,3.7],[4.3,5.0],[4.9,5.7],[6.6,7.7],[7.4,8.7],[8.1,9.5]],
      // Row +6°F
      [[1.1,1.1],[3.3,3.7],[4.3,4.9],[4.9,5.6],[6.6,7.7],[7.4,8.6],[8.1,9.5]],
      // Row +5°F
      [[1.0,1.1],[3.2,3.6],[4.2,4.9],[4.8,5.6],[6.5,7.6],[7.3,8.6],[8.0,9.4]],
      // Row +4°F
      [[0.8,0.9],[3.0,3.4],[4.0,4.7],[4.6,5.4],[6.3,7.4],[7.1,8.4],[7.8,9.2]],
      // Row +3°F
      [[0.8,0.8],[2.9,3.3],[3.9,4.6],[4.5,5.3],[6.2,7.4],[7.0,8.3],[7.7,9.2]],
      // Row +2°F
      [[0.6,0.6],[2.7,3.2],[3.7,4.4],[4.3,5.1],[6.0,7.2],[6.8,8.1],[7.5,9.0]],
      // Row 0 (S=0 baseline row): col 0 = BASELINE label cell
      [null,        [2.1,2.6],[3.1,3.8],[3.7,4.5],[5.4,6.6],[6.2,7.5],[6.9,8.4]],
    ];

    // % reduction → green gradient color. Anchored to 0% (pale) and
    // ~8.8% (deep). Matches the screenshot legend.
    function cellColor(pct) {
      const t = Math.max(0, Math.min(1, pct / 8.8));
      const stops = [
        { p: 0.00, c: [240, 245, 224] },
        { p: 0.18, c: [197, 217, 106] },
        { p: 0.50, c: [124, 179,  66] },
        { p: 1.00, c: [ 58, 107,  42] },
      ];
      let a = stops[0], b = stops[stops.length - 1];
      for (let i = 0; i < stops.length - 1; i++) {
        if (t >= stops[i].p && t <= stops[i + 1].p) { a = stops[i]; b = stops[i + 1]; break; }
      }
      const k = (t - a.p) / (b.p - a.p || 1);
      const rgb = a.c.map((cc, i) => Math.round(cc + (b.c[i] - cc) * k));
      return `rgb(${rgb.join(",")})`;
    }

    // Build grid: corner cell, 7 col labels, then 7 rows of (row-label + 7 cells)
    function build() {
      grid.innerHTML = "";
      // First DOM row: corner + col labels (col-labels actually sit BELOW
      // the cells visually — we'll inject the col-label row at the
      // bottom via CSS row order. Simpler: top corner is empty, and
      // we append a col-label row at the END of the grid.

      // Render rows top-down
      for (let r = 0; r < ROWS; r++) {
        // Row label cell
        const rlbl = document.createElement("div");
        rlbl.className = "mxp__row-lbl";
        rlbl.textContent = formatOffset(ROW_LBLS_F[r]);
        grid.appendChild(rlbl);
        // Seven data cells
        for (let c = 0; c < COLS; c++) {
          const cell = document.createElement("button");
          cell.type = "button";
          cell.className = "mxp__cell";
          cell.dataset.row = String(r);
          cell.dataset.col = String(c);
          cell.setAttribute("role", "gridcell");
          cell.setAttribute("aria-selected", "false");
          const vals = CELLS[r][c];
          if (vals === null) {
            cell.classList.add("is-baseline");
            cell.textContent = "BASELINE";
            cell.style.background = "rgba(10,116,214,0.42)";
          } else {
            // Compact range display: cells communicate a sensitivity
            // band, not a point estimate. Color still keyed to midpoint
            // for consistent gradient encoding.
            const mid = (vals[0] + vals[1]) / 2;
            cell.style.background = cellColor(mid);
            cell.textContent = `${vals[0].toFixed(1)}–${vals[1].toFixed(1)}%`;
          }
          cell.setAttribute("aria-label",
            `Summer setback ${formatOffset(ROW_LBLS_F[r])}, winter setback ${formatOffset(COL_LBLS_F[c])}`);
          cell.addEventListener("mouseenter", () => activate(r, c, cell));
          cell.addEventListener("focus",      () => activate(r, c, cell));
          cell.addEventListener("click",      () => activate(r, c, cell, true));
          grid.appendChild(cell);
        }
      }
      // Empty corner under row-label column
      const corner = document.createElement("div");
      grid.appendChild(corner);
      // 7 column labels along the bottom
      COL_LBLS_F.forEach((lbl) => {
        const cl = document.createElement("div");
        cl.className = "mxp__col-lbl";
        cl.textContent = formatOffset(lbl);
        grid.appendChild(cl);
      });
    }

    // (row, col) → scenario index. BASELINE = scenario 0; otherwise
    // (6 − row) × 7 + col gives the index into the SCENARIOS array,
    // matching the order panel screenshots were originally captured.
    function scenarioIndexFor(r, c) {
      return (6 - r) * 7 + c;
    }

    // Pinned scenario — set by clicking a cell. Hover transient-updates
    // the panel; on mouseleave we revert to the pinned cell (not always
    // baseline) so the user can park a scenario and look at it.
    let activeCell = null;
    let pinnedCell = null;
    function activate(r, c, cellEl, pin) {
      const idx = scenarioIndexFor(r, c);
      renderPpScenario(idx);

      const vals = CELLS[r][c];
      const isBaseline = vals === null;
      const wLbl = formatOffset(COL_LBLS_F[c]);
      const sLbl = formatOffset(ROW_LBLS_F[r]);
      currentReadoutR = r;
      currentReadoutC = c;
      const reductionLbl = isBaseline
        ? "no setback · baseline"
        : `${vals[0].toFixed(1)}% – ${vals[1].toFixed(1)}% energy reduction`;
      if (readout) {
        readout.textContent = isBaseline
          ? "Baseline · no setback · 0.00% offset across all bins"
          : `Winter ${wLbl} · Summer ${sLbl} · ${reductionLbl}`;
      }
      if (activeCell) {
        activeCell.classList.remove("is-active");
        activeCell.setAttribute("aria-selected", "false");
      }
      if (cellEl) {
        cellEl.classList.add("is-active");
        cellEl.setAttribute("aria-selected", "true");
        activeCell = cellEl;
      }
      if (pin) pinnedCell = cellEl;
    }

    grid.addEventListener("mouseleave", () => {
      // Revert to pinned (or baseline) instead of dropping back every time
      const target = pinnedCell || grid.querySelector(".mxp__cell.is-baseline");
      const r = parseInt(target.dataset.row, 10);
      const c = parseInt(target.dataset.col, 10);
      activate(r, c, target);
    });

    // Chrome chip click wiring. Each group (intervention / setback
    // start / setback end / clock format / °F/°C / Monday-occupancy)
    // is a mutually-exclusive aria-pressed toggle. The matrix grid
    // itself remains the source of truth for scenario state; these
    // chips toggle visual state to feel like real controls.
    function wireGroup(selector) {
      const btns = Array.from(root.querySelectorAll(selector));
      btns.forEach((b) => {
        b.addEventListener("click", () => {
          btns.forEach((x) => {
            const on = x === b;
            x.classList.toggle("is-active", on);
            x.setAttribute("aria-pressed", on ? "true" : "false");
          });
        });
      });
    }
    // Inert chrome (intervention tabs, setback start/end chips) is now
    // rendered as <span> in the HTML — no click handlers needed. The
    // truly interactive view-state controls (clock format + unit) get
    // real handlers below that re-render every region that displays a
    // time or temperature.
    //
    // [data-mxp-occ] is deliberately NOT in wireGroup either — that's
    // the real panel-lens control (see setOccupancy / renderPpScenario).

    // ---------- View state: clock format + unit ----------
    let clockFormat = "24";  // "24" | "12"
    let unit = "F";          // "F" | "C"

    // Format an HH:MM string per active clock format.
    //   formatTime("18:00") → "18:00" (24h) or "6:00 PM" (12h)
    //   formatTime("06:00") → "06:00" (24h) or "6:00 AM" (12h)
    function formatTime(t24) {
      const [hStr, m] = t24.split(":");
      const h = parseInt(hStr, 10);
      if (clockFormat === "12") {
        const period = h >= 12 ? "PM" : "AM";
        const h12 = ((h + 11) % 12) + 1;
        return `${h12}:${m} ${period}`;
      }
      return t24;
    }
    // Convert a Fahrenheit offset string ("+7°F", "−2°F", "0") to the
    // active unit's display. Offsets are 5/9 ratio.
    function formatOffset(fahrLbl) {
      if (fahrLbl === "0") return "0";
      const m = fahrLbl.match(/^([+−-])(\d+(?:\.\d+)?)°F$/);
      if (!m) return fahrLbl;
      const sign = m[1] === "+" ? 1 : -1;
      const valF = sign * parseFloat(m[2]);
      if (unit === "C") {
        const valC = valF * 5 / 9;
        const rounded = Math.abs(valC) < 0.05 ? "0" : valC.toFixed(1);
        const s = valC > 0 ? "+" : (valC < 0 ? "−" : "");
        return rounded === "0" ? "0" : `${s}${Math.abs(parseFloat(rounded)).toFixed(1)}°C`;
      }
      return fahrLbl;
    }
    // Convert a scenario label ("W −2°F / S +2°F", "Baseline") to the
    // active unit. Preserves the "Baseline" sentinel literal.
    function formatScenarioLabel(rawLabel) {
      if (rawLabel === "Baseline") return "Baseline";
      // Replace each °F offset segment
      return rawLabel.replace(/(W|S)\s+([+−-]?\d+(?:\.\d+)?°F|0)/g, (_, axis, val) => {
        return `${axis} ${formatOffset(val)}`;
      });
    }

    // Re-render every region that displays a time or temperature based
    // on the current clockFormat + unit. Called after either toggle.
    function refreshViewLabels() {
      // Chrome pill: "FRI HH:MM → MON HH:MM"
      const pill = document.getElementById("mxp-chrome-pill");
      if (pill) pill.textContent = `FRI ${formatTime("18:00")} → MON ${formatTime("06:00")}`;
      // Foot labels
      const footStart = document.getElementById("mxp-foot-start");
      const footEnd = document.getElementById("mxp-foot-end");
      if (footStart) footStart.textContent = `Friday ${formatTime("18:00")}`;
      if (footEnd) footEnd.textContent = `Monday ${formatTime("06:00")}`;
      // Setback chip labels (display only — chips are inert spans)
      document.querySelectorAll("[data-mxp-time]").forEach((el) => {
        el.textContent = formatTime(el.dataset.mxpTime);
      });
      // Axis labels (unit only)
      const yLbl = document.getElementById("mxp-y-axis-lbl");
      const xLbl = document.getElementById("mxp-x-axis-lbl");
      if (yLbl) yLbl.textContent = `SUMMER WEEKEND TEMPERATURE OFFSET (°${unit})`;
      if (xLbl) xLbl.textContent = `WINTER WEEKEND TEMPERATURE OFFSET (°${unit})`;
      // Matrix row / col labels — re-render based on unit
      document.querySelectorAll(".mxp__row-lbl").forEach((el, i) => {
        el.textContent = formatOffset(ROW_LBLS_F[i]);
      });
      document.querySelectorAll(".mxp__col-lbl").forEach((el, i) => {
        el.textContent = formatOffset(COL_LBLS_F[i]);
      });
      // Per-cell aria-labels: keep AT in sync with the visible unit
      // (cells were originally given °F labels in build()).
      document.querySelectorAll(".mxp__cell").forEach((cell) => {
        const r = parseInt(cell.dataset.row, 10);
        const c = parseInt(cell.dataset.col, 10);
        if (Number.isFinite(r) && Number.isFinite(c)) {
          cell.setAttribute("aria-label",
            `Summer setback ${formatOffset(ROW_LBLS_F[r])}, winter setback ${formatOffset(COL_LBLS_F[c])}`);
        }
      });
      // Scenario label in Healthy People panel
      if (ppScenarioLbl) {
        const dataset = SCENARIO_SLICES[occupancySlice];
        if (dataset) {
          const s = dataset[currentScenarioIdx] || dataset[0];
          ppScenarioLbl.textContent = formatScenarioLabel(s.l);
        }
      }
      // Readout text
      if (readout) {
        const vals = CELLS[currentReadoutR][currentReadoutC];
        const isBaseline = vals === null;
        const wLbl = formatOffset(COL_LBLS_F[currentReadoutC]);
        const sLbl = formatOffset(ROW_LBLS_F[currentReadoutR]);
        const reductionLbl = isBaseline
          ? "no setback · baseline"
          : `${vals[0].toFixed(1)}% – ${vals[1].toFixed(1)}% energy reduction`;
        readout.textContent = isBaseline
          ? "Baseline · no setback · 0.00% offset across all bins"
          : `Winter ${wLbl} · Summer ${sLbl} · ${reductionLbl}`;
      }
    }

    // Wire clock + unit as real view-state controls
    document.querySelectorAll("[data-mxp-clock]").forEach((btn) => {
      btn.addEventListener("click", () => {
        clockFormat = btn.dataset.mxpClock;
        document.querySelectorAll("[data-mxp-clock]").forEach((b) => {
          const on = b === btn;
          b.classList.toggle("is-active", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        });
        refreshViewLabels();
      });
    });
    document.querySelectorAll("[data-mxp-unit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        unit = btn.dataset.mxpUnit;
        document.querySelectorAll("[data-mxp-unit]").forEach((b) => {
          const on = b === btn;
          b.classList.toggle("is-active", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        });
        refreshViewLabels();
      });
    });

    build();
    // Initialize at BASELINE — activate() → renderPpScenario() now
    // draws the tower per-scenario, so no separate init call needed.
    activate(6, 0, grid.querySelector('.mxp__cell.is-baseline'));
  })();

  /* Legacy slide-16 module (heatmap + Healthy People SVG). Disabled —
     replaced by the image-backed matrix49 above. Kept as a no-op so any
     stale references resolve cleanly. */
  (function matrix16() {
    const grid = document.getElementById("mx16-grid");
    const bldg = document.getElementById("mx16-bldg");
    const bins = document.getElementById("mx16-bins");
    const readout = document.getElementById("mx16-cell-readout");
    if (!grid || !bldg || !bins) return;

    // Axes — outdoor temperature columns (low → high °F) and HVAC
    // shift rows (-0°F at the bottom → -10°F at the top, deeper setbacks
    // produce bigger reductions). Same shape as slide 16.
    const OUTDOOR_TEMPS = [0, 10, 20, 30, 40, 50, 60, 70];           // °F
    const HVAC_SHIFTS   = [-0, -2, -4, -6, -8, -10];                 // °F, displayed top-down
    // Baseline lives in the bottom-left corner of slide 16.

    // % energy reduction model — combine HVAC setback depth with how
    // close the outdoor temperature is to the heating/cooling setpoint
    // sweet spot (around 50-60°F). Deeper setbacks + mid temperatures
    // give the biggest reductions; extreme temperatures attenuate.
    function reductionFor(shift, outdoor) {
      if (shift === 0) return 0;
      const depth = Math.abs(shift) / 10;                            // 0..1
      const distFromSweet = Math.abs(outdoor - 55) / 55;             // 0..~1.3
      const tempPenalty = Math.max(0, 1 - distFromSweet * 0.85);
      return Math.max(0, depth * tempPenalty * 8.4);                  // up to ~8%
    }

    // Color scale — gray (0%) → light green → deep green (8%+)
    function cellColor(pct) {
      if (pct <= 0) return "rgba(178,204,238,0.06)";
      const t = Math.min(1, pct / 8);
      // interpolate light→deep green
      const stops = [
        { p: 0.0, c: [197, 217, 106] },                              // c5d96a
        { p: 0.45, c: [124, 179, 66] },                              // 7cb342
        { p: 1.0, c: [58, 107, 42] },                                // 3a6b2a
      ];
      let a = stops[0], b = stops[stops.length - 1];
      for (let i = 0; i < stops.length - 1; i++) {
        if (t >= stops[i].p && t <= stops[i + 1].p) { a = stops[i]; b = stops[i + 1]; break; }
      }
      const k = (t - a.p) / (b.p - a.p || 1);
      const rgb = a.c.map((cc, i) => Math.round(cc + (b.c[i] - cc) * k));
      return `rgb(${rgb.join(",")})`;
    }

    // Baseline bin distribution + how each cell tilts it. As the
    // outdoor temperature pulls away from the comfort zone, more
    // occupants slide from Optimized → Excellent → Action → Alert →
    // Limit. Aggressive setbacks compound the tilt.
    const BASELINE_BINS = [81.0, 13.3, 3.1, 1.3, 1.4];               // matches slide-16 figure
    const BIN_NAMES = ["Health Optimized", "Excellent", "Action", "Alert", "Limit"];
    const BIN_COLORS = ["#0a74d6", "#b2ccee", "#ffeb95", "#fcbc7e", "#f5896d"];

    function tiltFor(shift, outdoor) {
      if (shift === 0) return BASELINE_BINS.slice();                 // baseline
      // Severity score: deeper setback × distance from comfort zone (55°F)
      const depth = Math.abs(shift) / 10;
      const tempDist = Math.abs(outdoor - 55) / 55;
      const severity = depth * (0.45 + tempDist * 0.95);             // 0..~1.5
      // Tilt: shave from top bins, push into bottom bins
      const moveFromOpt = Math.min(BASELINE_BINS[0] * 0.18, BASELINE_BINS[0] * severity * 0.18);
      const moveFromExc = Math.min(BASELINE_BINS[1] * 0.5,  BASELINE_BINS[1] * severity * 0.5);
      // Distribute into Action / Alert / Limit
      const into = moveFromOpt + moveFromExc;
      const intoAction = into * 0.55;
      const intoAlert  = into * 0.30;
      const intoLimit  = into * 0.15;
      const out = [
        BASELINE_BINS[0] - moveFromOpt,
        BASELINE_BINS[1] - moveFromExc,
        BASELINE_BINS[2] + intoAction,
        BASELINE_BINS[3] + intoAlert,
        BASELINE_BINS[4] + intoLimit,
      ];
      return out;
    }

    // ---------- Render the grid ----------
    function renderGrid() {
      grid.innerHTML = "";
      // First row: empty corner + outdoor-temp column labels
      grid.style.gridTemplateColumns = `48px repeat(${OUTDOOR_TEMPS.length}, minmax(0, 1fr))`;
      grid.style.gridTemplateRows = `auto repeat(${HVAC_SHIFTS.length}, minmax(0, 1fr))`;

      // Column-label row
      const corner = document.createElement("div");
      grid.appendChild(corner);
      OUTDOOR_TEMPS.forEach((t) => {
        const lbl = document.createElement("div");
        lbl.className = "mx16__grid-collbl";
        lbl.textContent = t + "°F";
        grid.appendChild(lbl);
      });

      // Data rows, top-down: deepest setback (-10°F) first
      const rowsTopDown = HVAC_SHIFTS.slice().sort((a, b) => a - b); // [-10, -8, ..., 0]
      rowsTopDown.forEach((shift) => {
        const rowLbl = document.createElement("div");
        rowLbl.className = "mx16__grid-rowlbl";
        rowLbl.textContent = (shift === 0 ? "0" : shift) + "°F";
        grid.appendChild(rowLbl);
        OUTDOOR_TEMPS.forEach((outdoor) => {
          const cell = document.createElement("div");
          cell.className = "mx16__cell";
          cell.dataset.shift = String(shift);
          cell.dataset.outdoor = String(outdoor);
          if (shift === 0 && outdoor === OUTDOOR_TEMPS[0]) {
            cell.classList.add("is-baseline");
            cell.textContent = "BASELINE";
          } else {
            const pct = reductionFor(shift, outdoor);
            cell.style.background = cellColor(pct);
            cell.textContent = pct.toFixed(1) + "%";
          }
          cell.addEventListener("mouseenter", () => applyCell(shift, outdoor, cell));
          cell.addEventListener("focus",      () => applyCell(shift, outdoor, cell));
          cell.tabIndex = 0;
          grid.appendChild(cell);
        });
      });
    }

    // ---------- Render the Healthy People panel ----------
    function renderBuilding(pcts) {
      // Stacked vertical tower made of 5 segments; each segment height
      // is proportional to its bin percentage. As the cell hover tilts
      // the distribution, the tower visibly shifts color weight.
      bldg.innerHTML = "";
      const total = pcts.reduce((a, b) => a + b, 0) || 100;
      const top = 20, bot = 268, height = bot - top;
      let y = top;
      const ns = "http://www.w3.org/2000/svg";
      // Outline frame
      const frame = document.createElementNS(ns, "rect");
      frame.setAttribute("x", "20"); frame.setAttribute("y", "16");
      frame.setAttribute("width", "80"); frame.setAttribute("height", "256");
      frame.setAttribute("fill", "none");
      frame.setAttribute("stroke", "rgba(178,204,238,0.45)");
      frame.setAttribute("stroke-width", "1");
      bldg.appendChild(frame);
      // Roof slab
      const roof = document.createElementNS(ns, "polygon");
      roof.setAttribute("points", "20,16 100,16 92,8 28,8");
      roof.setAttribute("fill", "rgba(178,204,238,0.08)");
      roof.setAttribute("stroke", "rgba(178,204,238,0.35)");
      bldg.appendChild(roof);

      pcts.forEach((p, i) => {
        const h = (p / total) * height;
        const seg = document.createElementNS(ns, "rect");
        seg.setAttribute("x", "22");
        seg.setAttribute("y", y.toFixed(1));
        seg.setAttribute("width", "76");
        seg.setAttribute("height", Math.max(0, h - 1).toFixed(1));
        seg.setAttribute("fill", BIN_COLORS[i]);
        seg.setAttribute("opacity", "0.92");
        seg.style.transition = "y 320ms cubic-bezier(.2,.8,.2,1), height 320ms cubic-bezier(.2,.8,.2,1)";
        bldg.appendChild(seg);
        y += h;
      });
      // Ground line
      const ground = document.createElementNS(ns, "line");
      ground.setAttribute("x1", "10"); ground.setAttribute("x2", "110");
      ground.setAttribute("y1", "272"); ground.setAttribute("y2", "272");
      ground.setAttribute("stroke", "rgba(178,204,238,0.18)");
      bldg.appendChild(ground);
    }

    function renderBins(pcts, deltas) {
      bins.innerHTML = BIN_NAMES.map((name, i) => {
        const d = deltas[i];
        const dStr = d == null ? "—" : ((d >= 0 ? "+" : "−") + Math.abs(d).toFixed(2) + "%");
        const dCls = d == null || Math.abs(d) < 0.005
          ? ""
          : d > 0
            ? (i >= 2 ? " is-neg" : " is-pos")
            : (i >= 2 ? " is-pos" : " is-neg");
        return `<div class="mx16__bin">
          <span class="mx16__bin-dot" style="background:${BIN_COLORS[i]}"></span>
          <span class="mx16__bin-k">${name}</span>
          <span class="mx16__bin-v">${pcts[i].toFixed(1)}%</span>
          <span class="mx16__bin-d${dCls}">${dStr}</span>
        </div>`;
      }).join("");
    }

    // ---------- Apply hovered cell to the Healthy People panel ----------
    let activeCell = null;
    function applyCell(shift, outdoor, el) {
      // Visual selection
      if (activeCell) activeCell.classList.remove("is-active");
      if (el) { el.classList.add("is-active"); activeCell = el; }

      // Recompute distribution + deltas
      const tilted = tiltFor(shift, outdoor);
      const deltas = tilted.map((v, i) => +(v - BASELINE_BINS[i]).toFixed(2));
      renderBuilding(tilted);
      renderBins(tilted, deltas);

      // Readout copy
      const pct = reductionFor(shift, outdoor);
      const shiftLbl = shift === 0 ? "0°F (baseline)" : `${shift}°F setback`;
      readout.textContent = `${shiftLbl} · ${outdoor}°F outdoor · ${pct.toFixed(1)}% reduction`;
    }

    // Initial state: baseline (0°F shift, 0°F outdoor cell is BASELINE)
    renderGrid();
    renderBuilding(BASELINE_BINS);
    renderBins(BASELINE_BINS, [0, 0, 0, 0, 0]);
  })();

  /* ============================================================ H.E.A.A.L.
     Platform-fidelity surface — building plot · time series · space-time
     map · floor and parameter toggles. The brief asks us not to redesign
     the platform speculatively, so the composition is the
     recognizable HEAAL "building plot on the left, scrolling parameter
     on the right" layout, with restrained web-native interaction. */

  /* ============================================================ H.E.A.A.L.
     Hardcoded reconstruction per 9f_heaal_hardcoded_rebuild_brief.md.
     Real HTML/CSS/SVG — no screenshot, no image overlays. Parameter
     pills (CO₂ / PM2.5 / TVOC / Temp) swap bin %s, the highlighted
     sensor card, chart titles, the SpaceTime heatmap intensity, the
     Timeseries plotted line + band thresholds, and the axis scale.
     Tower geometry and the visible layout chrome are identical across
     parameters (matches the platform behavior in the source). */
  (function heaalHardcoded() {
    const root = document.getElementById("hlx");
    if (!root) return;
    const NS = "http://www.w3.org/2000/svg";
    const E = (tag, attrs) => {
      const el = document.createElementNS(NS, tag);
      if (attrs) Object.entries(attrs).forEach(([k,v]) => el.setAttribute(k, v));
      return el;
    };
    const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); };

    // ---------- Bin definitions (constant across parameters) ----------
    const BINS = [
      { k: "Health Optimized", letter: "H", color: "#3F8FE6", text: "#0a1422" },
      { k: "Excellent",        letter: "E", color: "#B2CCEE", text: "#0a1422" },
      { k: "Action",           letter: "A", color: "#E2C75E", text: "#0a1422" },
      { k: "Alert",            letter: "A", color: "#FCBC7E", text: "#0a1422" },
      { k: "Limit",            letter: "L", color: "#E47A6A", text: "#0a1422" },
    ];

    // Timeseries point sets traced from the 4 source HEAAL screenshots
    // by scanning each chart's white plot-line pixel-by-pixel and
    // converting to the chart's data scale. 152 samples each, uniformly
    // distributed across the ~30-day x-axis. These are measured values
    // from the captured platform states, not procedural waveforms.
    const TS_TRACED = {
      co2:  [541.2,525.3,521.7,537.5,531.4,521.7,511.9,519.2,516.7,508.2,518.0,688.2,749.4,570.6,509.4,513.0,562.1,760.4,710.2,516.7,511.9,516.7,732.3,716.3,513.0,505.7,515.6,677.1,890.2,611.0,513.0,509.4,597.5,769.0,711.4,518.0,508.2,509.4,518.0,516.7,529.0,516.7,532.6,520.4,524.1,530.2,526.5,537.5,542.5,537.5,542.5,546.1,530.2,537.5,772.7,727.3,531.4,510.6,525.3,764.0,841.3,634.3,540.0,522.8,642.9,757.9,674.7,526.5,522.8,524.1,749.4,718.8,541.2,526.5,552.3,532.6,540.0,538.8,537.5,520.4,542.5,531.4,535.1,524.1,536.3,548.6,805.7,745.7,527.8,536.3,525.3,672.2,789.8,666.1,513.0,514.3,617.2,830.2,716.3,541.2,515.6,538.8,732.3,717.5,536.3,530.2,537.5,775.1,826.5,604.9,529.0,529.0,542.5,541.2,526.5,527.8,515.6,520.4,515.6,521.7,536.3,531.4,530.2,706.5,781.2,607.4,518.0,518.0,570.6,797.2,707.8,538.8,524.1,521.7,762.9,868.2,530.2,533.9,527.8,531.4,529.0,519.2,510.6,515.6,546.1,660.0,619.6,519.2,513.0,518.0,519.2,585.3],
      pm25: [4.8,4.8,4.8,4.8,4.8,4.8,4.7,4.9,4.9,5.1,4.8,4.9,10.5,4.8,5.0,4.8,5.7,11.9,10.4,5.0,4.8,5.1,5.6,5.3,5.3,4.8,4.9,5.6,6.5,5.0,5.1,5.1,5.2,7.8,7.1,5.7,5.9,5.0,5.9,5.0,5.2,5.8,5.8,4.8,4.8,4.8,4.8,4.8,5.1,5.0,5.0,5.1,5.1,5.1,11.3,5.0,4.7,4.8,5.0,9.1,12.9,5.5,4.8,4.8,5.6,11.3,5.3,4.8,4.9,5.0,5.5,5.2,5.8,5.1,5.6,5.7,5.6,5.1,5.5,4.6,5.4,5.4,5.3,5.2,5.1,5.1,17.8,8.2,6.5,5.3,5.1,5.7,8.4,5.4,5.0,5.1,5.3,12.0,5.2,4.9,4.7,4.8,8.4,6.8,8.3,4.9,5.0,8.9,8.3,8.0,5.1,5.1,5.1,5.1,5.0,5.4,5.7,4.8,4.8,5.0,4.8,4.8,4.9,4.8,4.8,5.1,4.8,5.5,4.8,5.0,4.9,5.7,4.8,4.8,5.1,12.4,4.8,4.8,4.8,4.7,4.8,5.1,4.9,26.9,4.7,4.8,5.0,5.0,4.9,4.8,4.8,7.3],
      tvoc: [373.4,365.7,396.2,386.7,352.4,354.3,380.9,405.7,388.6,354.3,350.4,468.6,643.9,441.8,344.8,348.6,384.7,613.3,885.8,365.7,380.9,359.9,466.6,483.8,350.4,382.9,390.5,438.1,601.9,455.3,367.6,384.7,417.2,569.5,504.7,348.6,352.4,346.6,356.2,356.2,350.4,350.4,346.6,348.6,358.1,361.9,350.4,350.4,350.4,361.9,377.2,377.2,438.1,434.3,706.7,676.2,400.0,386.7,382.9,645.7,693.3,470.5,358.1,352.4,392.4,552.4,495.2,352.4,356.2,354.3,453.3,622.9,361.9,386.7,426.7,409.5,400.0,409.5,388.6,390.5,422.8,438.1,432.3,438.1,443.8,476.1,756.1,569.5,409.5,350.4,352.4,455.3,443.8,403.8,350.4,346.6,430.5,674.2,432.3,396.2,354.3,359.9,481.9,539.0,379.0,356.2,359.9,470.5,556.2,440.0,361.9,384.7,367.6,400.0,400.0,394.2,365.7,367.6,369.5,396.2,403.8,356.2,348.6,441.8,567.6,453.3,352.4,359.9,363.9,500.9,472.4,365.7,369.5,363.9,436.2,617.1,382.9,352.4,352.4,346.6,358.1,359.9,371.4,388.6,354.3,468.6,489.6,407.7,426.7,430.5,422.8,495.2],
      temp: [64.4,64.4,66.5,66.4,64.4,64.4,64.4,66.0,66.0,64.4,62.7,64.4,66.0,64.8,62.7,62.7,62.7,64.4,67.7,62.2,62.7,62.7,64.3,65.6,63.9,62.7,62.7,62.2,62.0,66.0,64.4,63.1,62.7,66.0,67.7,62.7,62.7,62.7,63.1,65.6,67.7,64.4,62.7,62.7,64.4,67.7,65.6,64.4,62.2,61.0,59.3,57.2,61.0,61.0,62.6,64.4,63.9,62.7,62.7,62.2,64.4,66.0,63.1,62.7,63.1,65.6,64.0,62.7,64.4,62.7,64.7,65.6,64.4,64.4,64.4,64.4,66.4,69.4,67.7,66.0,66.0,66.0,67.7,66.8,66.0,66.0,67.6,69.4,63.6,63.6,64.4,63.6,66.4,68.5,64.4,64.4,64.4,67.7,67.7,63.4,62.7,61.8,64.2,66.9,64.5,64.4,64.4,61.9,67.5,62.2,62.5,62.7,62.7,64.4,66.4,67.7,64.9,64.4,64.7,67.7,69.1,66.0,64.4,63.5,64.5,66.0,62.7,62.7,62.7,65.2,64.5,62.7,62.7,61.8,61.2,64.4,64.0,62.7,62.7,61.0,61.0,63.6,62.7,61.0,61.0,64.4,64.4,62.7,61.0,61.0,61.0,62.7],
    };

    // ---------- Parameter specs ----------
    // Bin %s, card highlight, SpaceTime density read off the source
    // screenshots. Timeseries `data` arrays are pixel-traced point sets
    // (TS_TRACED above) — not procedural waveforms.
    const PARAMS = {
      co2: {
        label: "CO<sub>2</sub>",
        bins: [99.1, 0.9, 0.0, 0.0, 0.0],
        card: "co2",
        ts: {
          yMin: 300, yMax: 1200,
          bands: [
            { from: 300,  to: 800,  color: "#1d4ea0", opacity: 0.92 },
            { from: 800,  to: 1000, color: "#7AA8E0", opacity: 0.78 },
            { from: 1000, to: 1200, color: "#F5E5A1", opacity: 0.85 },
          ],
          axis: [300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200],
          data: TS_TRACED.co2,
        },
        st: { cleanRatio: 0.92, breakBand: true },
      },
      pm25: {
        label: "PM<sub>2.5</sub>",
        bins: [94.0, 5.5, 0.5, 0.0, 0.0],
        card: "pm25",
        ts: {
          yMin: 0, yMax: 35,
          bands: [
            { from: 0,  to: 12, color: "#1d4ea0", opacity: 0.92 },
            { from: 12, to: 35, color: "#F5E5A1", opacity: 0.85 },
          ],
          axis: [0, 5, 10, 15, 20, 25, 30, 35],
          data: TS_TRACED.pm25,
        },
        st: { cleanRatio: 0.75, breakBand: true, density: 0.55 },
      },
      tvoc: {
        label: "TVOC",
        bins: [90.4, 9.5, 0.0, 0.0, 0.0],
        card: "tvoc",
        ts: {
          yMin: 0, yMax: 1400,
          bands: [
            { from: 0,    to: 800,  color: "#1d4ea0", opacity: 0.92 },
            { from: 800,  to: 1400, color: "#7AA8E0", opacity: 0.78 },
          ],
          axis: [0, 200, 400, 600, 800, 1000, 1200, 1400],
          data: TS_TRACED.tvoc,
        },
        st: { cleanRatio: 0.86, breakBand: true },
      },
      temp: {
        label: "Temperature",
        bins: [61.0, 30.1, 8.6, 0.3, 0.0],
        card: "temp",
        ts: {
          yMin: 50, yMax: 80,
          bands: [
            { from: 50, to: 68, color: "#1d4ea0", opacity: 0.92 },
            { from: 68, to: 76, color: "#7AA8E0", opacity: 0.78 },
            { from: 76, to: 80, color: "#F5E5A1", opacity: 0.85 },
          ],
          axis: [50, 55, 60, 65, 70, 75, 80],
          data: TS_TRACED.temp,
        },
        st: { cleanRatio: 0.65, breakBand: false, tinted: true },
      },
    };

    // Card values (constant across parameter switches; only the
    // highlighted card changes).
    const CARDS = [
      { k: "co2",  label: "CO<sub>2</sub>",   v: "524", u: "ppm" },
      { k: "pm25", label: "PM<sub>2.5</sub>", v: "4",   u: "µg/m³", sub: "Outdoor 8" },
      { k: "tvoc", label: "TVOC",            v: "194", u: "ppb" },
      { k: "temp", label: "Temp.",           v: "72",  u: "°F" },
      { k: "rh",   label: "RH",              v: "32",  u: "%" },
    ];

    // X-axis date span (≈30 days)
    const DATE_LABELS = ["4/17","4/19","4/21","4/23","4/25","4/27","4/29","5/1","5/3","5/5","5/7","5/9","5/11","5/13","5/15"];

    // ---------- Seeded RNG ----------
    function rngS(seed) { let s = seed; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; }

    // ---------- DOM refs ----------
    const tower = document.getElementById("hlx-tower");
    const binsList = document.getElementById("hlx-bins");
    const cards = document.getElementById("hlx-cards");
    const stSvg = document.getElementById("hlx-st");
    const tsSvg = document.getElementById("hlx-ts");
    const stTitle = document.getElementById("hlx-st-title");
    const tsTitle = document.getElementById("hlx-ts-title");
    const pills = root.querySelectorAll(".hlx__pills--param .hlx__pill");

    // ---------- Tower (5 isometric stacked segments) ----------
    // Each segment is now a 0-100% horizontal bar — the bin color fills
    // from the left wall toward the right in proportion to the bin's
    // current percentage. Re-renders on every parameter switch so the
    // tower visibly responds to the active state.
    function drawTower(bins) {
      clear(tower);
      const W = 120, H = 280;
      tower.setAttribute("viewBox", `0 0 ${W} ${H}`);
      const segH = 44;
      const startY = 10;
      const xLeft = 22, xRight = 90;
      const skewY = 8;
      const interior = xRight - xLeft;

      BINS.forEach((bin, i) => {
        const y = startY + i * segH;
        const pct = Math.max(0, Math.min(100, bins[i] || 0));
        const fillW = (pct / 100) * interior;
        const bodyY = y + skewY;
        const bodyH = segH - skewY - 2;

        // Body background (dark base for the empty portion)
        tower.appendChild(E("rect", {
          x: xLeft, y: bodyY, width: interior, height: bodyH,
          fill: "rgba(178,204,238,0.04)",
        }));
        // Bin-colored fill bar (left-anchored, proportional)
        if (fillW > 0.5) {
          tower.appendChild(E("rect", {
            x: xLeft, y: bodyY, width: fillW, height: bodyH,
            fill: bin.color, opacity: 0.92,
          }));
        }
        // Body outline
        tower.appendChild(E("rect", {
          x: xLeft, y: bodyY, width: interior, height: bodyH,
          fill: "none", stroke: "rgba(178,204,238,0.6)", "stroke-width": 1,
        }));
        // Iso roof slab
        tower.appendChild(E("polygon", {
          points: `${xLeft},${bodyY} ${xRight},${bodyY} ${xRight + skewY},${y} ${xLeft - skewY},${y}`,
          fill: "rgba(178,204,238,0.05)",
          stroke: "rgba(178,204,238,0.6)", "stroke-width": 1,
        }));
        // Iso right side
        tower.appendChild(E("polygon", {
          points: `${xRight},${bodyY} ${xRight + skewY},${y} ${xRight + skewY},${y + segH - 2 - skewY} ${xRight},${y + segH - 2}`,
          fill: "rgba(0,0,0,0.22)",
          stroke: "rgba(178,204,238,0.6)", "stroke-width": 1,
        }));
      });
      // Base platform
      const baseY = startY + 5 * segH;
      tower.appendChild(E("polygon", {
        points: `${xLeft-5},${baseY+skewY} ${xRight+5},${baseY+skewY} ${xRight + skewY + 5},${baseY} ${xLeft - skewY - 5},${baseY}`,
        fill: "rgba(178,204,238,0.05)",
        stroke: "rgba(178,204,238,0.4)", "stroke-width": 1,
      }));
    }

    // ---------- Bin rows ----------
    function renderBins(pcts) {
      binsList.innerHTML = BINS.map((b, i) => `
        <li class="hlx__bin">
          <span class="hlx__bin-badge" style="background:${b.color}; color:${b.text}">${b.letter}</span>
          <span class="hlx__bin-meta">
            <span class="hlx__bin-k">${b.k}</span>
          </span>
          <span class="hlx__bin-v">${pcts[i].toFixed(1)}%</span>
        </li>
      `).join("");
    }

    // ---------- Sensor cards ----------
    function renderCards(activeKey) {
      cards.innerHTML = CARDS.map((c) => `
        <div class="hlx__card${c.k === activeKey ? " is-active" : ""}" data-card="${c.k}">
          <span class="hlx__card-k">${c.label}</span>
          <span class="hlx__card-v">${c.v}<span class="hlx__card-u">&nbsp;${c.u}</span></span>
          ${c.sub ? `<span class="hlx__card-sub">${c.sub}</span>` : ""}
        </div>
      `).join("");
    }

    // ---------- SpaceTime Map ----------
    // Big blue field with a dark horizontal break band near top (the
    // "no-data / sensor gap" line in the platform) and scattered tiny
    // light marks across the lower band representing anomaly events.
    function renderSpaceTime(p) {
      clear(stSvg);
      const W = 600, H = 280;
      stSvg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      const PAD = { l: 38, r: 8, t: 8, b: 22 };
      const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;

      // y-axis label (rotated)
      const yLbl = E("text", {
        x: -H / 2, y: 14,
        transform: "rotate(-90)",
        "text-anchor": "middle",
        fill: "rgba(178,204,238,0.5)",
        "font-size": 9, "font-family": "JetBrains Mono", "letter-spacing": "0.04em",
      });
      yLbl.textContent = "Sensor by Floor";
      stSvg.appendChild(yLbl);

      // Big blue heat field — overall calmness driven by cleanRatio
      const base = E("rect", {
        x: PAD.l, y: PAD.t, width: iw, height: ih,
        fill: p.tinted ? "#3D7DB8" : "#3A7BC8",
      });
      stSvg.appendChild(base);

      // Floor markers (y axis ticks at 8 and 12)
      ["08", "12"].forEach((floor, idx) => {
        const ty = PAD.t + ih * (idx === 0 ? 0.78 : 0.18);
        const t = E("text", {
          x: PAD.l - 6, y: ty + 3,
          "text-anchor": "end",
          fill: "rgba(178,204,238,0.6)",
          "font-size": 9, "font-family": "JetBrains Mono", "font-variant-numeric": "tabular-nums",
        });
        t.textContent = floor;
        stSvg.appendChild(t);
      });

      // Dark "break" band near the top (the floor-08 gap line)
      if (p.breakBand) {
        stSvg.appendChild(E("rect", {
          x: PAD.l, y: PAD.t + ih * 0.21, width: iw, height: 3,
          fill: "#0a131f", opacity: 0.95,
        }));
      }

      // Scatter tiny marks across the lower band (anomaly density)
      const r = rngS(91);
      const N = Math.round(420 * (p.density != null ? p.density : (1 - p.cleanRatio) + 0.18));
      for (let i = 0; i < N; i++) {
        const x = PAD.l + r() * iw;
        const y = PAD.t + ih * (0.35 + r() * 0.6);
        const size = 0.6 + r() * 1.2;
        const op = 0.35 + r() * 0.5;
        stSvg.appendChild(E("rect", {
          x: x.toFixed(1), y: y.toFixed(1),
          width: size.toFixed(1), height: size.toFixed(1),
          fill: "#e8f0fc", opacity: op.toFixed(2),
        }));
      }

      // X-axis date labels (sparse)
      const datesToShow = DATE_LABELS.filter((_, i) => i % 2 === 0);
      datesToShow.forEach((d, i) => {
        const x = PAD.l + (i / (datesToShow.length - 1)) * iw;
        const t = E("text", {
          x, y: H - 6,
          "text-anchor": "middle",
          fill: "rgba(178,204,238,0.5)",
          "font-size": 8, "font-family": "JetBrains Mono",
        });
        t.textContent = d;
        stSvg.appendChild(t);
      });
    }

    // ---------- Timeseries Plot ----------
    function renderTimeseries(p) {
      clear(tsSvg);
      const W = 600, H = 260;
      tsSvg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      const PAD = { l: 44, r: 12, t: 10, b: 22 };
      const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
      const ts = p.ts;
      const yS = (v) => PAD.t + (1 - (v - ts.yMin) / (ts.yMax - ts.yMin)) * ih;
      const xS = (t) => PAD.l + t * iw;

      // Background bands
      ts.bands.forEach((band) => {
        const y0 = yS(band.to);
        const y1 = yS(band.from);
        tsSvg.appendChild(E("rect", {
          x: PAD.l, y: y0,
          width: iw, height: Math.max(0, y1 - y0),
          fill: band.color, opacity: band.opacity,
        }));
      });
      tsSvg.appendChild(E("rect", {
        x: PAD.l, y: PAD.t, width: iw, height: ih,
        fill: "none", stroke: "rgba(178,204,238,0.18)", "stroke-width": 0.6,
      }));

      // Y-axis tick labels
      ts.axis.forEach((v) => {
        const y = yS(v);
        const t = E("text", {
          x: PAD.l - 6, y: y + 3,
          "text-anchor": "end",
          fill: "rgba(178,204,238,0.6)",
          "font-size": 9, "font-family": "JetBrains Mono", "font-variant-numeric": "tabular-nums",
        });
        t.textContent = String(v);
        tsSvg.appendChild(t);
      });

      // Plot line — uses pixel-traced point set from the source
      // screenshot, mapped to the chart's data scale.
      const data = ts.data; // array of y values, uniformly spaced
      const N = data.length;
      const clamp = (v) => Math.max(ts.yMin, Math.min(ts.yMax, v));
      const pathD = data.map((v, i) => {
        const x = xS(i / (N - 1));
        const y = yS(clamp(v));
        return (i ? "L" : "M") + x.toFixed(1) + "," + y.toFixed(1);
      }).join(" ");
      tsSvg.appendChild(E("path", {
        d: pathD, fill: "none",
        stroke: "#f1f5fb", "stroke-width": 1.2,
        "stroke-linecap": "round", "stroke-linejoin": "round",
        opacity: 0.95,
      }));
      // Markers every Nth point
      data.forEach((v, i) => {
        if (i % 6 !== 0) return;
        tsSvg.appendChild(E("circle", {
          cx: xS(i / (N - 1)).toFixed(1),
          cy: yS(clamp(v)).toFixed(1),
          r: 1.4, fill: "#f1f5fb", opacity: 0.9,
        }));
      });

      // X-axis date labels
      const datesToShow = DATE_LABELS.filter((_, i) => i % 2 === 0);
      datesToShow.forEach((d, i) => {
        const x = PAD.l + (i / (datesToShow.length - 1)) * iw;
        const t = E("text", {
          x, y: H - 6,
          "text-anchor": "middle",
          fill: "rgba(178,204,238,0.55)",
          "font-size": 8, "font-family": "JetBrains Mono",
        });
        t.textContent = d;
        tsSvg.appendChild(t);
      });
    }

    // ---------- Apply parameter ----------
    function apply(key) {
      const p = PARAMS[key];
      if (!p) return;
      drawTower(p.bins);
      renderBins(p.bins);
      renderCards(p.card);
      stTitle.innerHTML = `H.E.A.A.L. ${p.label} &middot; SpaceTime Map`;
      tsTitle.innerHTML = `H.E.A.A.L. ${p.label} Timeseries Plot`;
      renderSpaceTime(p.st);
      renderTimeseries(p);
      pills.forEach((pill) => {
        const on = pill.dataset.hlxParam === key;
        pill.classList.toggle("is-active", on);
        pill.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }

    pills.forEach((pill) => {
      pill.addEventListener("click", () => apply(pill.dataset.hlxParam));
    });

    // Time window + view marker are now inert .hlx__ref-badge spans in
    // the markup (captured 30-day reference, singleton Building view).
    // No click handlers — they read as printed labels, not toggles.

    // Initial render — apply() draws everything including the tower
    apply("co2");
  })();

  /* Legacy SVG-based HEAAL module — disabled. Replaced by heaal4 above.
     Kept as a no-op guard so any orphaned hl-* elements don't error. */
  (function heaal() {
    const plot = document.getElementById("hl-plot");
    const time = document.getElementById("hl-time");
    const heat = document.getElementById("hl-heat");
    if (!plot || !time || !heat) return;

    const SVG_NS = "http://www.w3.org/2000/svg";
    function el(tag, attrs = {}) {
      const e = document.createElementNS(SVG_NS, tag);
      Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
      return e;
    }
    function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

    // -------- Parameter spec
    // Each parameter knows its unit, threshold bands (Optimized → Limit
    // per brand standards §6), and an accent color (the brand's tested-
    // element palette). Bands let the building plot and space-time map
    // re-color the same sensor against the same science thresholds.
    const PARAMS = {
      pm25: {
        label: "PM₂.₅",
        unit:  "µg/m³",
        accent: "#7AA12A",
        thresholds: [4, 8, 12, 35], // Optimized < 4 ≤ Excellent < 8 ≤ Action < 12 ≤ Alert < 35 ≤ Limit
        fmt: (v) => v.toFixed(1),
      },
      co2: {
        label: "CO₂",
        unit:  "ppm",
        accent: "#3E8D5E",
        thresholds: [550, 700, 900, 1100],
        fmt: (v) => Math.round(v).toLocaleString(),
      },
      tvoc: {
        label: "TVOC",
        unit:  "µg/m³",
        accent: "#00A383",
        thresholds: [100, 200, 350, 500],
        fmt: (v) => Math.round(v).toLocaleString(),
      },
      trh: {
        // Internal key kept as `trh` so the floor baselines and reading
        // generators don't shift; user-visible label is Temperature only.
        // Relative humidity is not surfaced here — combining T and RH in
        // one scalar trace was misleading. If RH ever needs surfacing,
        // add it as its own parameter.
        label: "Temperature",
        unit:  "°C",
        accent: "#6BA6F1",
        thresholds: [21, 22, 23, 24], // ASHRAE-style setpoint band
        fmt: (v) => v.toFixed(1),
      },
    };

    const BIN_COLORS = ["#0A74D6", "#B2CCEE", "#FFEB95", "#FCBC7E", "#F5896D"];
    const BIN_NAMES  = ["Optimized", "Excellent", "Action", "Alert", "Limit"];

    function binFor(value, thresholds) {
      // Returns 0..4 for the 5 brand bins.
      for (let i = 0; i < thresholds.length; i++) {
        if (value < thresholds[i]) return i;
      }
      return thresholds.length;
    }

    // -------- Floor layouts
    // Each floor has a different sensor layout and slightly different
    // parameter baselines. Floor 2 is the live demo state by default —
    // it has alerts on PM₂.₅ and a slight CO₂ rise late afternoon.
    function sensorGrid(rows, cols) {
      const list = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) list.push({ r, c });
      return list;
    }
    const FLOORS = {
      "1": { name: "Floor 1 · West",  bldg: "BLDG-04A", sensors: sensorGrid(4, 6), score: 82, baseline: { pm25: 9.5, co2: 720, tvoc: 165, trh: 22.8 } },
      "2": { name: "Floor 2 · Mech",  bldg: "BLDG-04A", sensors: sensorGrid(4, 6), score: 86, baseline: { pm25: 8.6, co2: 612, tvoc: 142, trh: 21.4 } },
      "3": { name: "Floor 3 · East",  bldg: "BLDG-04A", sensors: sensorGrid(4, 6), score: 91, baseline: { pm25: 5.8, co2: 488, tvoc: 96,  trh: 21.1 } },
    };

    // -------- Synthetic but stable hourly readings per sensor
    // Each sensor index produces a 24-hour series. Seeded RNG makes the
    // readings repeatable across redraws and floor switches.
    function readingsForFloor(floor, paramKey) {
      const f = FLOORS[floor];
      const base = f.baseline[paramKey];
      const series = []; // [sensorIdx][hour]
      const param = PARAMS[paramKey];
      const seedBase = (floor.charCodeAt(0) + paramKey.charCodeAt(0)) * 17;
      f.sensors.forEach((s, i) => {
        const r = rng(seedBase + i * 37);
        const hourly = [];
        // Sensor offset: row variance shifts mean ±15%, col variance ±8%
        const sensorOffset = ((s.r - 1.5) * 0.06 + (s.c - 2.5) * 0.03) * base;
        for (let h = 0; h < 24; h++) {
          const diurnal =
            paramKey === "co2"  ? Math.sin((h - 8) / 24 * Math.PI * 2) * base * 0.18
          : paramKey === "tvoc" ? Math.sin((h - 10) / 24 * Math.PI * 2) * base * 0.12
          : paramKey === "trh"  ? Math.sin((h - 12) / 24 * Math.PI * 2) * 1.4
          :                       Math.cos((h - 14) / 24 * Math.PI * 2) * base * 0.10;
          const noise = (r() - 0.5) * base * 0.06;
          let v = base + sensorOffset + diurnal + noise;
          // Floor 2 — inject a small late-afternoon spike on one sensor for PM₂.₅
          if (floor === "2" && paramKey === "pm25" && i === 9 && h >= 14 && h <= 18) v += 4.5;
          v = Math.max(0, v);
          hourly.push(v);
        }
        series.push(hourly);
      });
      return series;
    }

    // -------- State
    // Initial state mirrors the deck's H.E.A.A.L. console (slide 18):
    // TRH parameter active, Floor 2. The tab chip restores the deck's
    // "TRH" shorthand for recognition; the data model is temperature-
    // only, and a disclosure strip under the console (.hl2__disclosure)
    // makes that explicit. The 30d / 7d range chips were removed in the
    // trust-repair pass — they couldn't actually swap the window.
    const state = { floor: "2", param: "trh" };

    // -------- Building plot
    function drawPlot() {
      clear(plot);
      const param = PARAMS[state.param];
      const f = FLOORS[state.floor];
      const W = 360, H = 240;
      plot.setAttribute("viewBox", `0 0 ${W} ${H}`);
      const pad = { l: 22, r: 22, t: 22, b: 28 };
      // Floor outline — rectangle with a clipped corner so it reads as a plan
      plot.appendChild(el("rect", {
        x: pad.l, y: pad.t, width: W - pad.l - pad.r, height: H - pad.t - pad.b,
        fill: "rgba(178,204,238,0.04)",
        stroke: "rgba(178,204,238,0.32)",
        "stroke-width": 1,
      }));
      // Internal walls (mech rooms)
      plot.appendChild(el("rect", {
        x: pad.l + 10, y: pad.t + 10, width: 70, height: 40,
        fill: "none", stroke: "rgba(178,204,238,0.16)", "stroke-width": 0.7,
      }));
      plot.appendChild(el("rect", {
        x: W - pad.r - 70 - 10, y: H - pad.b - 50, width: 70, height: 40,
        fill: "none", stroke: "rgba(178,204,238,0.16)", "stroke-width": 0.7,
      }));
      // Floor label
      plot.appendChild(el("text", {
        x: pad.l, y: pad.t - 8,
        fill: "rgba(178,204,238,0.55)",
        "font-family": "JetBrains Mono",
        "font-size": 9,
        "letter-spacing": "0.14em",
      })).textContent = (f.name + " · " + f.bldg).toUpperCase();
      // North arrow
      plot.appendChild(el("text", {
        x: W - pad.r, y: pad.t - 8, "text-anchor": "end",
        fill: "rgba(178,204,238,0.4)",
        "font-family": "JetBrains Mono", "font-size": 9, "letter-spacing": "0.14em",
      })).textContent = "↑ N";

      // Sensors — placed on a regular grid inside the floor plan
      const innerX = pad.l + 20;
      const innerY = pad.t + 30;
      const innerW = W - pad.l - pad.r - 40;
      const innerH = H - pad.t - pad.b - 50;
      const readings = readingsForFloor(state.floor, state.param);
      f.sensors.forEach((s, i) => {
        const x = innerX + (s.c + 0.5) / 6 * innerW;
        const y = innerY + (s.r + 0.5) / 4 * innerH;
        const lastValue = readings[i][readings[i].length - 1];
        const bin = binFor(lastValue, param.thresholds);
        const c = BIN_COLORS[Math.min(4, bin)];
        // Sensor halo (soft)
        plot.appendChild(el("circle", { cx: x, cy: y, r: 12, fill: c, opacity: 0.14 }));
        // Sensor dot
        plot.appendChild(el("circle", {
          cx: x, cy: y, r: 5.5,
          fill: c, stroke: "#0a1422", "stroke-width": 1.2,
        }));
        // Sensor ID
        plot.appendChild(el("text", {
          x: x, y: y + 18,
          "text-anchor": "middle",
          fill: "rgba(149,163,184,0.7)",
          "font-family": "JetBrains Mono", "font-size": 7.5,
          "letter-spacing": "0.06em",
        })).textContent = "S" + String(i + 1).padStart(2, "0");
      });

      // Legend (bins active)
      const legend = document.getElementById("hl-plot-legend");
      if (legend) {
        legend.innerHTML = BIN_NAMES.map((n, i) =>
          `<span><i style="background:${BIN_COLORS[i]}"></i>${n}</span>`
        ).join("");
      }
    }

    // -------- Time series
    function drawTime() {
      clear(time);
      const param = PARAMS[state.param];
      const series = readingsForFloor(state.floor, state.param);
      // Spatial average across sensors → primary line. Min/max envelope shaded.
      const HOURS = 24;
      const avg = [], lo = [], hi = [];
      for (let h = 0; h < HOURS; h++) {
        let s = 0, minV = Infinity, maxV = -Infinity;
        for (let i = 0; i < series.length; i++) {
          const v = series[i][h];
          s += v;
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
        }
        avg.push(s / series.length);
        lo.push(minV);
        hi.push(maxV);
      }

      const W = 480, H = 140;
      time.setAttribute("viewBox", `0 0 ${W} ${H}`);
      time.setAttribute("preserveAspectRatio", "none");
      const pad = { l: 38, r: 12, t: 12, b: 24 };
      const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
      // Y range pinned to ~1.25× max sensor reading
      const maxY = Math.max(...hi) * 1.15;
      const minY = Math.min(0, Math.min(...lo) * 0.95);
      const xS = (h) => pad.l + (h / (HOURS - 1)) * iw;
      const yS = (v) => pad.t + (1 - (v - minY) / (maxY - minY)) * ih;

      // Threshold bands — soft horizontal strips so users can see at a
      // glance which bin the live trace is in.
      const thresh = param.thresholds;
      const bandBoundaries = [minY, ...thresh, maxY].filter((v, i, arr) => i === 0 || v > arr[i - 1]);
      for (let i = 0; i < bandBoundaries.length - 1; i++) {
        const yTop = yS(bandBoundaries[i + 1]);
        const yBot = yS(bandBoundaries[i]);
        time.appendChild(el("rect", {
          x: pad.l, y: yTop,
          width: iw, height: Math.max(0, yBot - yTop),
          fill: BIN_COLORS[i] || BIN_COLORS[4], opacity: 0.06,
        }));
      }
      // Axis gridlines
      [0, 0.25, 0.5, 0.75, 1].forEach((t) => {
        const v = minY + (maxY - minY) * (1 - t);
        const y = pad.t + t * ih;
        time.appendChild(el("line", {
          x1: pad.l, x2: W - pad.r, y1: y, y2: y,
          stroke: "rgba(178,204,238,0.06)", "stroke-width": 0.6,
        }));
        const tx = el("text", {
          x: pad.l - 6, y: y + 3, "text-anchor": "end",
          fill: "#5f6c80",
          "font-family": "JetBrains Mono", "font-size": 8.5,
        });
        tx.textContent = param.fmt(v);
        time.appendChild(tx);
      });
      // Hour ticks
      [0, 6, 12, 18, 23].forEach((h) => {
        const x = xS(h);
        time.appendChild(el("line", {
          x1: x, x2: x, y1: H - pad.b, y2: H - pad.b + 3,
          stroke: "rgba(178,204,238,0.18)",
        }));
        const tx = el("text", {
          x: x, y: H - 6, "text-anchor": "middle",
          fill: "#5f6c80",
          "font-family": "JetBrains Mono", "font-size": 8.5,
        });
        tx.textContent = String(h).padStart(2, "0") + ":00";
        time.appendChild(tx);
      });

      // Envelope
      const envPath = (
        avg.map((_, i) => (i ? "L" : "M") + xS(i).toFixed(1) + "," + yS(hi[i]).toFixed(1)).join(" ") +
        " " +
        avg.slice().reverse().map((_, j) => {
          const i = HOURS - 1 - j;
          return "L" + xS(i).toFixed(1) + "," + yS(lo[i]).toFixed(1);
        }).join(" ") +
        " Z"
      );
      time.appendChild(el("path", {
        d: envPath, fill: param.accent, opacity: 0.18,
      }));
      // Average trace
      const avgPath = avg.map((v, i) => (i ? "L" : "M") + xS(i).toFixed(1) + "," + yS(v).toFixed(1)).join(" ");
      time.appendChild(el("path", {
        d: avgPath, fill: "none", stroke: param.accent,
        "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round",
      }));
      // Latest marker
      const lastV = avg[avg.length - 1];
      time.appendChild(el("circle", {
        cx: xS(HOURS - 1), cy: yS(lastV), r: 3.4,
        fill: param.accent, stroke: "#0a1422", "stroke-width": 1.2,
      }));
      // Update header readouts
      const timeNow = document.getElementById("hl-time-now");
      const timeUnit = document.getElementById("hl-time-unit");
      const timeTitle = document.getElementById("hl-time-title");
      if (timeNow) timeNow.textContent = param.fmt(lastV);
      if (timeUnit) timeUnit.textContent = param.unit;
      // Reference window only — 30d / 7d range tabs were removed in the
      // trust-repair pass because they couldn't actually swap the data
      // window. Title stays anchored to the parameter; the disclosure
      // strip under the console names this as a reference console.
      if (timeTitle) timeTitle.innerHTML = `H.E.A.A.L. ${param.label} · Timeseries`;
    }

    // -------- Space-time heatmap
    function drawHeat() {
      clear(heat);
      const param = PARAMS[state.param];
      const series = readingsForFloor(state.floor, state.param);
      const N = series.length;
      const HOURS = 24;
      const heatTitle = document.getElementById("hl-heat-title");
      if (heatTitle) heatTitle.innerHTML = `H.E.A.A.L. ${param.label} · SpaceTime Map`;
      const W = 480, H = 130;
      heat.setAttribute("viewBox", `0 0 ${W} ${H}`);
      heat.setAttribute("preserveAspectRatio", "none");
      const pad = { l: 38, r: 12, t: 10, b: 22 };
      const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
      const cellW = iw / HOURS;
      const cellH = ih / N;
      // Cells colored by threshold bin per reading
      for (let i = 0; i < N; i++) {
        for (let h = 0; h < HOURS; h++) {
          const v = series[i][h];
          const bin = binFor(v, param.thresholds);
          const x = pad.l + h * cellW;
          const y = pad.t + i * cellH;
          heat.appendChild(el("rect", {
            x: x.toFixed(1), y: y.toFixed(1),
            width: cellW.toFixed(1), height: cellH.toFixed(1),
            fill: BIN_COLORS[Math.min(4, bin)],
            opacity: 0.65,
          }));
        }
      }
      // Sensor labels (Y axis)
      for (let i = 0; i < N; i += Math.max(1, Math.floor(N / 4))) {
        const y = pad.t + (i + 0.5) * cellH + 3;
        heat.appendChild(el("text", {
          x: pad.l - 6, y, "text-anchor": "end",
          fill: "#5f6c80",
          "font-family": "JetBrains Mono", "font-size": 8.5,
        })).textContent = "S" + String(i + 1).padStart(2, "0");
      }
      // Hour ticks (X axis)
      [0, 6, 12, 18, 23].forEach((h) => {
        const x = pad.l + h * cellW + cellW / 2;
        heat.appendChild(el("text", {
          x, y: H - 6, "text-anchor": "middle",
          fill: "#5f6c80",
          "font-family": "JetBrains Mono", "font-size": 8.5,
        })).textContent = String(h).padStart(2, "0") + ":00";
      });
    }

    // -------- Bin breakdown + live values (slide-18 left-column blocks)
    // Computes the % distribution across the 5 brand bins for the active
    // floor + parameter, and a 5-reading live values mini-grid.
    function renderBins() {
      const wrap = document.getElementById("hl-bins");
      if (!wrap) return;
      const param = PARAMS[state.param];
      const readings = readingsForFloor(state.floor, state.param);
      const bins = [0, 0, 0, 0, 0];
      let total = 0;
      readings.forEach((s) => {
        s.forEach((v) => {
          const b = Math.min(4, binFor(v, param.thresholds));
          bins[b]++;
          total++;
        });
      });
      wrap.innerHTML = BIN_NAMES.map((name, i) => {
        const pct = total > 0 ? (bins[i] / total) * 100 : 0;
        return `<div class="hl2__bin">
          <span class="hl2__bin-dot" style="background:${BIN_COLORS[i]}"></span>
          <span class="hl2__bin-k">${name}</span>
          <span class="hl2__bin-v">${pct.toFixed(1)}%</span>
        </div>`;
      }).join("");

      // Update building label
      const bldgLabel = document.getElementById("hl-bldg-label");
      if (bldgLabel) {
        const f = FLOORS[state.floor];
        bldgLabel.textContent = `BLDG-04A · ${f.name}`;
      }
    }

    function renderLiveVals() {
      const wrap = document.getElementById("hl-live-vals");
      if (!wrap) return;
      // For each parameter, compute the spatial-average final-reading
      // for the current floor. Temperature shows °C only; RH is shown
      // as a static reference value (slide 18 shows 33%).
      const floorReadings = (paramKey) => {
        const series = readingsForFloor(state.floor, paramKey);
        let sum = 0;
        series.forEach((s) => { sum += s[s.length - 1]; });
        return sum / series.length;
      };
      const co2 = floorReadings("co2");
      const pm25 = floorReadings("pm25");
      const tvoc = floorReadings("tvoc");
      const temp = floorReadings("trh");
      const rh = 33; // reference value, deck slide 18

      const vals = [
        { k: "CO₂",   v: Math.round(co2).toLocaleString(), u: "ppm" },
        { k: "PM₂.₅", v: pm25.toFixed(1), u: "µg/m³" },
        { k: "TVOC",  v: Math.round(tvoc).toLocaleString(), u: "ppb" },
        { k: "Temp",  v: temp.toFixed(1), u: "°C" },
        { k: "RH",    v: String(rh), u: "%" },
      ];
      wrap.innerHTML = vals.map((v) =>
        `<div class="hl2__live-val">
          <span class="hl2__live-val-k">${v.k}</span>
          <span class="hl2__live-val-v">${v.v}</span>
          <span class="hl2__live-val-u">${v.u}</span>
        </div>`
      ).join("");
    }

    function redraw() {
      drawPlot();
      drawTime();
      drawHeat();
      renderBins();
      renderLiveVals();
    }

    // -------- Wire controls
    $$('[data-hl-floor]').forEach((btn) => {
      btn.addEventListener("click", () => {
        $$('[data-hl-floor]').forEach((b) => {
          const on = b === btn;
          b.classList.toggle("is-active", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        });
        state.floor = btn.dataset.hlFloor;
        redraw();
      });
    });
    $$('[data-hl-param]').forEach((btn) => {
      btn.addEventListener("click", () => {
        $$('[data-hl-param]').forEach((b) => {
          const on = b === btn;
          b.classList.toggle("is-active", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        });
        state.param = btn.dataset.hlParam;
        redraw();
      });
    });
    // Sensor view toggle (aggregate / by-sensor) — non-functional in
    // this build (the time-series chart already shows the spatial
    // average + min/max envelope, which is the deck's aggregate view).
    // The chip is a presentation-recognition affordance only.
    $$('[data-hl-sensor]').forEach((btn) => {
      btn.addEventListener("click", () => {
        $$('[data-hl-sensor]').forEach((b) => {
          const on = b === btn;
          b.classList.toggle("is-active", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        });
      });
    });

    // ResizeObserver — only redraw time/heat (the plot is xMidYMid meet so it scales fine)
    if (typeof ResizeObserver !== "undefined") {
      let raf = 0;
      const ro = new ResizeObserver(() => {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => { raf = 0; drawTime(); drawHeat(); });
      });
      ro.observe(time);
    }

    // Initial paint
    redraw();
  })();

  /* ============================================================ smooth anchor scroll */

  $$('a[href^="#"]').forEach((a) => {
    a.addEventListener("click", (e) => {
      const id = a.getAttribute("href");
      if (id.length <= 1) return;
      const target = $(id);
      if (target) {
        e.preventDefault();
        const top = target.getBoundingClientRect().top + window.scrollY - 64;
        window.scrollTo({ top, behavior: REDUCED ? "auto" : "smooth" });
      }
    });
  });

})();
