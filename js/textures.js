/**
 * textures.js — procedural canvas textures (no external image assets).
 *
 * Generates:
 *   - boardTexture():  the full wooden playing surface in one 2048px canvas:
 *                      rim wood, 64 alternating squares with grain, file/rank
 *                      coordinate labels, a frame line and baked corner
 *                      ambient-occlusion darkening.
 *   - sideTexture():   wood for the board's sides/bottom.
 *   - environmentTexture(): small equirectangular gradient with two soft
 *                      "window" hotspots, fed through PMREMGenerator so the
 *                      physical materials get real reflections.
 *   - tableTexture():  dark radial-gradient surface for the table the board
 *                      sits on, fading into the page background.
 *   - marker textures: selection ring, move dot, capture ring (tinted by
 *                      material color at runtime).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Textures = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Deterministic PRNG so the board looks identical across reloads.
  var _seed = 1234567;
  function rnd() {
    _seed = (_seed * 1103515245 + 12345) & 0x7fffffff;
    return _seed / 0x7fffffff;
  }

  function rgba(hex, a) {
    var r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  /** Wavy wood grain strands across a rectangular region. */
  function grain(ctx, x, y, w, h, dark, light, strands, vertical) {
    for (var i = 0; i < strands; i++) {
      var t = rnd();
      var color = t < 0.5 ? dark : light;
      var alpha = 0.03 + rnd() * 0.09;
      ctx.strokeStyle = rgba(color, alpha);
      ctx.lineWidth = 0.6 + rnd() * 2.2;
      ctx.beginPath();
      var pos = (vertical ? x : y) + rnd() * (vertical ? w : h);
      var amp = 2 + rnd() * 9;
      var wav = 40 + rnd() * 160;
      if (vertical) {
        ctx.moveTo(pos, y - 10);
        for (var yy = y - 10; yy < y + h + 10; yy += 24) {
          ctx.quadraticCurveTo(pos + Math.sin(yy / wav) * amp, yy + 12, pos, yy + 24);
        }
      } else {
        ctx.moveTo(x - 10, pos);
        for (var xx = x - 10; xx < x + w + 10; xx += 24) {
          ctx.quadraticCurveTo(xx + 12, pos + Math.sin(xx / wav) * amp, xx + 24, pos);
        }
      }
      ctx.stroke();
    }
  }

  /** Sparse speckle noise for a lived-in wood feel. */
  function speckle(ctx, x, y, w, h, color, count) {
    for (var i = 0; i < count; i++) {
      ctx.fillStyle = rgba(color, 0.03 + rnd() * 0.05);
      ctx.fillRect(x + rnd() * w, y + rnd() * h, 1 + rnd() * 2, 1 + rnd() * 2);
    }
  }

  /**
   * Full board top surface. Board = 8 squares + rim on all sides; world size
   * 9.24 units, so px-per-unit = size / 9.24 and the squares region starts
   * at the rim margin.
   */
  function boardTexture(size) {
    size = size || 2048;
    var c = document.createElement('canvas');
    c.width = c.height = size;
    var ctx = c.getContext('2d');
    var ppu = size / 9.24;             // pixels per world unit
    var rim = 0.62 * ppu;              // rim width in px
    var sq = ppu;                      // one square = one world unit

    // --- rim ---------------------------------------------------------------
    ctx.fillStyle = '#43291a';
    ctx.fillRect(0, 0, size, size);
    grain(ctx, 0, 0, size, size, 0x2d1a0e, 0x5d3a20, 240, false);
    grain(ctx, 0, 0, size, size, 0x2d1a0e, 0x6a4526, 120, true);
    speckle(ctx, 0, 0, size, size, 0x1a0d05, 5000);

    // --- squares -----------------------------------------------------------
    var light = { base: 0xD9BE93, dark: 0xB4986B, light: 0xEAD5AF };
    var dark_ = { base: 0x7A5131, dark: 0x5A371E, light: 0x8F6A44 };
    var ox = rim, oy = rim;
    for (var r = 0; r < 8; r++) {
      for (var f = 0; f < 8; f++) {
        var pal = (r + f) % 2 === 0 ? dark_ : light; // a8 is a dark square
        var x = ox + f * sq, y = oy + r * sq;
        ctx.fillStyle = rgba(pal.base, 1);
        ctx.fillRect(x, y, sq, sq);
        grain(ctx, x, y, sq, sq, pal.dark, pal.light, 26, f % 2 === 0);
        speckle(ctx, x, y, sq, sq, pal.dark, 90);
        // Baked corner AO: darken each edge of every square very slightly.
        var g = ctx.createLinearGradient(x, y, x, y + sq);
        g.addColorStop(0, 'rgba(0,0,0,0.10)');
        g.addColorStop(0.18, 'rgba(0,0,0,0)');
        g.addColorStop(0.82, 'rgba(0,0,0,0)');
        g.addColorStop(1, 'rgba(0,0,0,0.10)');
        ctx.fillStyle = g;
        ctx.fillRect(x, y, sq, sq);
        var g2 = ctx.createLinearGradient(x, y, x + sq, y);
        g2.addColorStop(0, 'rgba(0,0,0,0.10)');
        g2.addColorStop(0.18, 'rgba(0,0,0,0)');
        g2.addColorStop(0.82, 'rgba(0,0,0,0)');
        g2.addColorStop(1, 'rgba(0,0,0,0.10)');
        ctx.fillStyle = g2;
        ctx.fillRect(x, y, sq, sq);
      }
    }

    // --- frame line + labels ----------------------------------------------
    ctx.strokeStyle = rgba(0xC9A96A, 0.65);
    ctx.lineWidth = 3;
    ctx.strokeRect(ox - 8, oy - 8, sq * 8 + 16, sq * 8 + 16);

    ctx.fillStyle = rgba(0xE8D8B4, 0.9);
    ctx.font = '600 ' + Math.floor(rim * 0.52) + 'px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var files = 'abcdefgh';
    for (var i = 0; i < 8; i++) {
      // files along bottom rim (white's view) and top rim
      ctx.fillText(files[i], ox + i * sq + sq / 2, size - rim / 2);
      ctx.fillText(files[i], ox + i * sq + sq / 2, rim / 2);
      // ranks along left and right rims (rank 8 at top)
      ctx.fillText(String(8 - i), rim / 2, oy + i * sq + sq / 2);
      ctx.fillText(String(8 - i), size - rim / 2, oy + i * sq + sq / 2);
    }

    // --- global vignette (soft AO toward the board edges) -------------------
    var v = ctx.createRadialGradient(size / 2, size / 2, size * 0.25, size / 2, size / 2, size * 0.75);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, size, size);

    return c;
  }

  function canvasTexture(canvas, aniso) {
    var t = new THREE.CanvasTexture(canvas);
    t.encoding = THREE.sRGBEncoding;
    t.anisotropy = aniso || 8;
    return t;
  }

  /** Wood for the board sides. */
  function sideTexture() {
    var c = document.createElement('canvas');
    c.width = 1024; c.height = 128;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#3d2415';
    ctx.fillRect(0, 0, c.width, c.height);
    grain(ctx, 0, 0, c.width, c.height, 0x24130a, 0x54331b, 130, false);
    speckle(ctx, 0, 0, c.width, c.height, 0x180c04, 1600);
    var g = ctx.createLinearGradient(0, 0, 0, c.height);
    g.addColorStop(0, 'rgba(255,235,200,0.12)'); // top edge catches light
    g.addColorStop(0.25, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    return c;
  }

  /** Equirectangular environment: warm studio gradient + two window hotspots. */
  function environmentTexture() {
    var c = document.createElement('canvas');
    c.width = 1024; c.height = 512;
    var ctx = c.getContext('2d');
    var g = ctx.createLinearGradient(0, 0, 0, c.height);
    g.addColorStop(0, '#cfd8e6');      // sky
    g.addColorStop(0.42, '#8d949f');
    g.addColorStop(0.55, '#4c4a48');   // horizon
    g.addColorStop(0.75, '#2b2724');   // floor
    g.addColorStop(1, '#1c1815');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    // Two soft warm windows (key light reflections live here).
    function blob(x, y, rx, ry, a) {
      var rg = ctx.createRadialGradient(x, y, 0, x, y, rx);
      rg.addColorStop(0, 'rgba(255,244,224,' + a + ')');
      rg.addColorStop(1, 'rgba(255,244,224,0)');
      ctx.save();
      ctx.translate(x, y); ctx.scale(1, ry / rx); ctx.translate(-x, -y);
      ctx.fillStyle = rg;
      ctx.fillRect(x - rx * 1.3, y - rx * 1.3, rx * 2.6, rx * 2.6);
      ctx.restore();
    }
    blob(240, 130, 150, 190, 0.95);
    blob(700, 100, 90, 120, 0.55);
    blob(560, 300, 260, 90, 0.10);     // faint floor bounce
    return c;
  }

  /** Dark table surface fading out at the edges. */
  function tableTexture() {
    var c = document.createElement('canvas');
    c.width = c.height = 1024;
    var ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(512, 512, 60, 512, 512, 512);
    g.addColorStop(0, '#3a332d');
    g.addColorStop(0.45, '#2a2521');
    g.addColorStop(0.8, '#1d1a18');
    g.addColorStop(1, '#141312');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1024, 1024);
    speckle(ctx, 0, 0, 1024, 1024, 0x000000, 2500);
    return c;
  }

  /** White-on-transparent marker shapes; tint via material.color. */
  function markerTexture(kind) {
    var S = 256;
    var c = document.createElement('canvas');
    c.width = c.height = S;
    var ctx = c.getContext('2d');
    ctx.strokeStyle = ctx.fillStyle = '#ffffff';
    if (kind === 'ring') {
      ctx.lineWidth = 14;
      ctx.beginPath();
      ctx.arc(S / 2, S / 2, S / 2 - 16, 0, Math.PI * 2);
      ctx.stroke();
    } else if (kind === 'dot') {
      ctx.beginPath();
      ctx.arc(S / 2, S / 2, S * 0.16, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'corner') { // selection: four corner brackets
      ctx.lineWidth = 16;
      var L = 52, m = 18, W = S;
      var pts = [[m, m, 1, 1], [W - m, m, -1, 1], [m, W - m, 1, -1], [W - m, W - m, -1, -1]];
      pts.forEach(function (p) {
        ctx.beginPath();
        ctx.moveTo(p[0] + p[2] * L, p[1]);
        ctx.lineTo(p[0], p[1]);
        ctx.lineTo(p[0], p[1] + p[3] * L);
        ctx.stroke();
      });
    } else if (kind === 'glow') { // soft full-square wash
      var g = ctx.createRadialGradient(S / 2, S / 2, S * 0.05, S / 2, S / 2, S / 2);
      g.addColorStop(0, 'rgba(255,255,255,0.55)');
      g.addColorStop(1, 'rgba(255,255,255,0.12)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
    }
    return c;
  }

  /** Soft black blob for fake contact shadows under pieces. */
  function contactShadowTexture() {
    var c = document.createElement('canvas');
    c.width = c.height = 128;
    var ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
    g.addColorStop(0, 'rgba(0,0,0,0.78)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.34)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    return c;
  }

  /**
   * Ivory marble for the white pieces: warm cream base with soft mineral
   * veins and fine speckle. Painted in final colors (material color = white).
   */
  function pieceIvoryTexture() {
    var c = document.createElement('canvas');
    c.width = c.height = 512;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#efe4cd';
    ctx.fillRect(0, 0, 512, 512);

    // Broad soft tonal clouds.
    for (var i = 0; i < 26; i++) {
      var x = rnd() * 512, y = rnd() * 512, r = 40 + rnd() * 120;
      var g = ctx.createRadialGradient(x, y, 0, x, y, r);
      var warm = rnd() < 0.5;
      g.addColorStop(0, rgba(warm ? 0xfdf6e4 : 0xdcc9a4, 0.10));
      g.addColorStop(1, rgba(warm ? 0xfdf6e4 : 0xdcc9a4, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }

    // Marble veins: meandering semi-transparent strokes.
    for (var v = 0; v < 14; v++) {
      var vx = rnd() * 512, vy = rnd() * 512;
      var ang = rnd() * Math.PI * 2;
      ctx.strokeStyle = rgba(0xb49d74, 0.14 + rnd() * 0.14);
      ctx.lineWidth = 0.8 + rnd() * 1.8;
      ctx.beginPath();
      ctx.moveTo(vx, vy);
      for (var s = 0; s < 9; s++) {
        ang += (rnd() - 0.5) * 1.1;
        vx += Math.cos(ang) * (22 + rnd() * 40);
        vy += Math.sin(ang) * (22 + rnd() * 40);
        ctx.lineTo(vx, vy);
      }
      ctx.stroke();
    }

    speckle(ctx, 0, 0, 512, 512, 0xc4ac82, 900);
    speckle(ctx, 0, 0, 512, 512, 0xfffaea, 700);
    return c;
  }

  /**
   * Ebony wood for the black pieces: near-black base with charcoal grain
   * streaks and a faint sheen variation. Painted in final colors.
   */
  function pieceEbonyTexture() {
    var c = document.createElement('canvas');
    c.width = c.height = 512;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#211a15';
    ctx.fillRect(0, 0, 512, 512);

    // Vertical grain streaks (u wraps the piece circumference, v its height).
    for (var i = 0; i < 170; i++) {
      var x = rnd() * 512;
      var w = 1 + rnd() * 5;
      var tone = rnd();
      ctx.fillStyle = rgba(tone < 0.6 ? 0x0f0b08 : 0x453629, 0.10 + rnd() * 0.16);
      ctx.fillRect(x, -8, w, 528 + 8);
    }
    // Wavy darker grain lines.
    for (var l = 0; l < 42; l++) {
      var lx = rnd() * 512;
      ctx.strokeStyle = rgba(0x0a0705, 0.22);
      ctx.lineWidth = 0.7 + rnd() * 1.4;
      ctx.beginPath();
      ctx.moveTo(lx, -8);
      for (var yy = -8; yy < 530; yy += 26) {
        ctx.quadraticCurveTo(lx + Math.sin(yy / 34 + l) * 5, yy + 13, lx + Math.sin(yy / 55) * 3, yy + 26);
      }
      ctx.stroke();
    }
    // Occasional lighter mineral flecks.
    speckle(ctx, 0, 0, 512, 512, 0x6a5540, 420);
    return c;
  }

  /**
   * Room backdrop for the cylinder behind the board: warm dark studio wall,
   * vertical gradient, faint paneling and two glowing "window" panels.
   * Designed to be seamless horizontally (no horizontal-only features).
   */
  function backdropTexture() {
    var c = document.createElement('canvas');
    c.width = 1024; c.height = 512;
    var ctx = c.getContext('2d');
    var g = ctx.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0, '#0e0c0b');      // ceiling
    g.addColorStop(0.30, '#241d18');   // upper wall
    g.addColorStop(0.62, '#3d332a');   // lit wall band
    g.addColorStop(0.80, '#2a231d');   // lower wall
    g.addColorStop(1, '#171310');      // floor fade
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1024, 512);

    // Faint vertical wall panels.
    for (var p = 0; p < 16; p++) {
      var x = p * 64 + 32;
      ctx.fillStyle = 'rgba(255,235,200,0.05)';
      ctx.fillRect(x - 1.6, 40, 3, 380);
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      ctx.fillRect(x + 2.2, 40, 2, 380);
    }
    // Horizontal trim lines.
    ctx.fillStyle = 'rgba(255,235,200,0.08)';
    ctx.fillRect(0, 120, 1024, 3);
    ctx.fillRect(0, 380, 1024, 3);

    // Two glowing window panels (warm, heavily feathered). CylinderGeometry
    // maps u=0 to +z, so the default camera (at +z looking to -z) sees the
    // wall around u=0.5 — place the windows at 0.40 and 0.60.
    function window_(cx, cy, w, h, a) {
      var rg = ctx.createRadialGradient(cx, cy, 2, cx, cy, Math.max(w, h));
      rg.addColorStop(0, 'rgba(255,232,190,' + a + ')');
      rg.addColorStop(0.45, 'rgba(255,220,170,' + (a * 0.4) + ')');
      rg.addColorStop(1, 'rgba(255,220,170,0)');
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(w / Math.max(w, h), h / Math.max(w, h));
      ctx.fillStyle = rg;
      ctx.fillRect(-Math.max(w, h), -Math.max(w, h), Math.max(w, h) * 2, Math.max(w, h) * 2);
      // bright core panel
      ctx.fillStyle = 'rgba(255,244,222,' + (a * 0.85) + ')';
      ctx.fillRect(-w * 0.22, -h * 0.34, w * 0.44, h * 0.68);
      ctx.restore();
    }
    // Windows sit in the wall band just above the far board edge — the part
    // of the cylinder the default camera actually sees (world y ≈ 5-7,
    // i.e. canvas y ≈ 280-300 given v = 1 - y/512 and a 44-tall cylinder).
    window_(410, 316, 175, 90, 0.60);
    window_(615, 320, 125, 75, 0.42);
    // A dim third window off to the side for orbiting views.
    window_(40, 318, 120, 75, 0.30);

    // Subtle grain.
    speckle(ctx, 0, 0, 1024, 512, 0x000000, 3200);
    speckle(ctx, 0, 0, 1024, 512, 0xffe8c8, 900);
    return c;
  }

  return {
    boardTexture: boardTexture,
    sideTexture: sideTexture,
    environmentTexture: environmentTexture,
    tableTexture: tableTexture,
    markerTexture: markerTexture,
    contactShadowTexture: contactShadowTexture,
    pieceIvoryTexture: pieceIvoryTexture,
    pieceEbonyTexture: pieceEbonyTexture,
    backdropTexture: backdropTexture,
    canvasTexture: canvasTexture,
    rgba: rgba
  };
});
