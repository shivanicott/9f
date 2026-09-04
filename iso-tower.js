// ---------------------------------------------------------------------
// renderIsometricStack(containerSelector, data, config)
//
// Reusable D3.js v7 component: renders the isometric "building" stack
// used in the HEAAL tower charts — 5 short, wide hexagonal-plate
// levels (front vertical edge centered and dipping below/rising less
// than the two back corners), each with a thin roof-plate collar
// between levels, and pointed tip caps at the very top and bottom.
// Geometry proportions are ported directly from the team's R/ggplot
// `building_outline()` helper so the shape matches that reference
// exactly (scaled by `config.scale`, R uses a 1.54-wide x 3.92-tall
// unit space with 5 levels on a 0.61 vertical period).
//
// `containerSelector` — CSS selector for an <svg> element (its
//   viewBox is set/overwritten by this function).
// `data` — array of layer objects, top-to-bottom (matches R's
//   H/E/A/A/L order):
//   { k, letter, label, color, text, value }
//   `value` is a 0-100 percentage of the layer's fill.
//   `label` (falls back to `letter`) is the badge glyph.
// `config` — optional overrides:
//   { width, scale, badgeRadius, wireColor, wireFill, capFill }
// ---------------------------------------------------------------------
function renderIsometricStack(containerSelector, data, config) {
  const cfg = Object.assign({
    width: 160,
    scale: 20,          // px per R-unit — note: has no visible effect on rendered
                         // size while the <svg> is styled width:100%/height:auto,
                         // since it scales viewBox width and height equally. To
                         // resize, tweak the aspect ratio (below) or the CSS column
                         // width instead.
    badgeRadius: 9,
    rightMargin: 14,     // extra empty px reserved to the right of the building
    wireColor: "rgba(178,204,238,0.55)",
    wireFill: "#05070c",
    capFill: "rgba(178,204,238,0.10)",
  }, config || {});

  const S = cfg.scale;
  const n = data.length;

  // ---- R-space constants (from building_outline()) ----
  const CX_R = 0.77;          // center / front-edge x
  const HALF_W_R = 0.77;      // half footprint width (x: 0..1.54)
  const SIDE_H_R = 0.51;      // side-edge (back corner) vertical span
  const FRONT_DIP_R = 0.31;   // how far below the side-bottom the front vertex sits
  const FRONT_RISE_R = 0.20;  // how far below the side-top the front vertex sits
  const PERIOD_R = 0.61;      // vertical spacing between levels
  const PLATE_IN_X_R = 0.12;  // roof-plate corner inset
  const PLATE_SIDE_R = 0.05;  // roof-plate extra rise at back side corners
  const PLATE_FRONT_R = 0.10; // roof-plate extra rise at back front corner
  const TIP_R = 0.31;         // extra pointed-tip rise/drop beyond the end plates

  const bottomB0 = 0.48;                       // R y of the lowest level's side-bottom
  const topB = bottomB0 + PERIOD_R * (n - 1);   // R y of the highest level's side-bottom
  // Vertical margins above/below the building — these (not `scale`) control
  // the rendered size, since the <svg> is width:100%/height:auto: a taller
  // viewBox for the same width renders a taller (bigger) element.
  const totalTopR = topB + SIDE_H_R + PLATE_SIDE_R + TIP_R + 0.18;
  const totalBotR = -0.2;

  const buildingWidth = HALF_W_R * 2 * S;
  const width = buildingWidth + cfg.rightMargin;
  const height = (totalTopR - totalBotR) * S;
  const cxPx = buildingWidth / 2; // keep the building itself centered in its own
                                  // footprint; rightMargin only pads the viewBox
  const baselinePx = totalTopR * S; // screen-y for R-y = 0... (see toXY)

  function toXY(xR, yR) {
    return [cxPx + (xR - CX_R) * S, baselinePx - yR * S];
  }
  function poly(...ptsR) {
    return ptsR.map(([x, y]) => toXY(x, y).join(",")).join(" ");
  }

  const svg = d3.select(containerSelector);
  svg.selectAll("*").remove();
  svg.attr("viewBox", `0 0 ${width} ${height}`)
     .attr("preserveAspectRatio", "xMidYMid meet");

  const root = svg.append("g").attr("class", "iso-stack");
  const defs = svg.append("defs");

  // ---- Bottom pointed foundation tip ----
  root.append("polygon")
    .attr("points", poly([0, bottomB0 - FRONT_DIP_R], [CX_R, bottomB0 - FRONT_DIP_R - TIP_R],
      [HALF_W_R * 2, bottomB0 - FRONT_DIP_R], [HALF_W_R * 2, bottomB0 - FRONT_DIP_R + 0.07],
      [CX_R, bottomB0 - FRONT_DIP_R - TIP_R + 0.07], [0, bottomB0 - FRONT_DIP_R + 0.07]))
    .attr("fill", cfg.capFill).attr("stroke", cfg.wireColor).attr("stroke-width", 1);

  data.forEach((d, i) => {
    const B = topB - PERIOD_R * i; // this level's side-bottom, R space
    const pct = Math.max(0, Math.min(100, +d.value || 0)) / 100;

    const frontBot = [CX_R, B - FRONT_DIP_R];
    const leftBot = [0, B];
    const rightBot = [HALF_W_R * 2, B];
    const frontTop = [CX_R, B + FRONT_RISE_R];
    const leftTop = [0, B + SIDE_H_R];
    const rightTop = [HALF_W_R * 2, B + SIDE_H_R];

    const g = root.append("g").attr("class", "iso-block");

    // ---- Wireframe base (empty-volume styling) ----
    g.append("polygon").attr("points", poly(leftBot, frontBot, frontTop, leftTop))
      .attr("fill", cfg.wireFill).attr("stroke", cfg.wireColor).attr("stroke-width", 1);
    g.append("polygon").attr("points", poly(rightBot, frontBot, frontTop, rightTop))
      .attr("fill", cfg.wireFill).attr("stroke", cfg.wireColor).attr("stroke-width", 1);

    // ---- Partial fill, left-to-right, clipped across the whole level ----
    if (pct > 0.004) {
      const id = `iso-clip-${i}-${Math.round(Math.random() * 1e6)}`;
      const [clipX] = toXY(0, 0);
      const fullW = buildingWidth * pct;
      defs.append("clipPath").attr("id", id).append("rect")
        .attr("x", clipX).attr("y", toXY(0, B + SIDE_H_R + PLATE_SIDE_R)[1])
        .attr("width", fullW)
        .attr("height", (SIDE_H_R + FRONT_DIP_R + FRONT_RISE_R + PLATE_SIDE_R) * S);

      const fillG = g.append("g").attr("clip-path", `url(#${id})`);
      fillG.append("polygon").attr("points", poly(leftBot, frontBot, frontTop, leftTop))
        .attr("fill", d.color).attr("opacity", 0.95);
      fillG.append("polygon").attr("points", poly(rightBot, frontBot, frontTop, rightTop))
        .attr("fill", d.color).attr("opacity", 0.82);
    }

    // ---- Crisp face outlines on top ----
    g.append("polygon").attr("points", poly(leftBot, frontBot, frontTop, leftTop))
      .attr("fill", "none").attr("stroke", cfg.wireColor).attr("stroke-width", 1);
    g.append("polygon").attr("points", poly(rightBot, frontBot, frontTop, rightTop))
      .attr("fill", "none").attr("stroke", cfg.wireColor).attr("stroke-width", 1);
    g.append("line")
      .attr("x1", toXY(...frontBot)[0]).attr("y1", toXY(...frontBot)[1])
      .attr("x2", toXY(...frontTop)[0]).attr("y2", toXY(...frontTop)[1])
      .attr("stroke", cfg.wireColor).attr("stroke-width", 1);

    // ---- Roof plate collar (thin lip sitting on top of this level) ----
    const roofPlate = [
      leftTop, frontTop, rightTop,
      [HALF_W_R * 2 - PLATE_IN_X_R, B + SIDE_H_R + PLATE_SIDE_R],
      [CX_R, B + FRONT_RISE_R + PLATE_FRONT_R],
      [PLATE_IN_X_R, B + SIDE_H_R + PLATE_SIDE_R],
    ];
    const isTopCap = i === 0; // the roof of the topmost (H) level is always an empty cap
    g.append("polygon").attr("points", poly(...roofPlate))
      .attr("fill", !isTopCap && pct > 0.98 ? d.color : cfg.capFill)
      .attr("fill-opacity", !isTopCap && pct > 0.98 ? 0.95 : 1)
      .attr("stroke", cfg.wireColor).attr("stroke-width", 1);

  });

  // ---- Top cap: a clean isometric rhombus, same projection as the rest
  // of the building (front vertex dips below the side corners by the
  // same amount the back vertex rises above them). ----
  const topSideY = topB + SIDE_H_R + PLATE_SIDE_R;
  const topFrontY = topB + FRONT_RISE_R + PLATE_FRONT_R;
  const topDip = topSideY - topFrontY;
  root.append("polygon")
    .attr("points", poly([0, topSideY], [CX_R, topFrontY], [HALF_W_R * 2, topSideY],
      [CX_R, topSideY + topDip]))
    .attr("fill", cfg.capFill).attr("stroke", cfg.wireColor).attr("stroke-width", 1);

  return root;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { renderIsometricStack };
}
