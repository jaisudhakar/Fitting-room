/**
 * garment3d — a realistic, animated 3D shirt, drawn with raw WebGL2.
 *
 * No libraries: the repository has no runtime dependencies and the demo has to
 * run from a file:// URL with no network, so the renderer, the geometry, the
 * cloth shading and the post-processing are all in this file.
 *
 *   const view = createGarmentView(canvas);
 *   view.update({ fit: 'tailored', sleeve: 'long', collar: 'classic', ... });
 *
 * How it works
 *   · The shirt is one *fixed topology* parameterised by the make-up. Every
 *     option — the block, the sleeve length, the collar, the hem — moves the
 *     same vertices rather than rebuilding the mesh, so any change can be
 *     morphed: the GPU lerps between two position/normal sets.
 *   · Lighting is a three-point studio rig evaluated analytically, with a
 *     sheen lobe and wrap-around transmission for the linen, hemispheric
 *     ambient and baked per-vertex occlusion.
 *   · The weave is procedural: warp and weft threads are evaluated per pixel,
 *     so the cloth holds up when you zoom into it.
 *   · The scene renders to a supersampled target; one post pass tone-maps it,
 *     adds bloom, a vignette and a little grain.
 */
(function (global) {
  'use strict';

  /* ── maths ───────────────────────────────────────────────────── */

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (t) => t * t * (3 - 2 * t);
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  const m4 = {
    identity: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),

    perspective(fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2);
      const nf = 1 / (near - far);
      return new Float32Array([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) * nf, -1,
        0, 0, 2 * far * near * nf, 0,
      ]);
    },

    lookAt(eye, target, up) {
      const z0 = eye[0] - target[0], z1 = eye[1] - target[1], z2 = eye[2] - target[2];
      let zl = Math.hypot(z0, z1, z2) || 1;
      const zx = z0 / zl, zy = z1 / zl, zz = z2 / zl;
      let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
      const xl = Math.hypot(xx, xy, xz) || 1;
      xx /= xl; xy /= xl; xz /= xl;
      const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
      return new Float32Array([
        xx, yx, zx, 0,
        xy, yy, zy, 0,
        xz, yz, zz, 0,
        -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
        -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
        -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
        1,
      ]);
    },

    multiply(a, b) {
      const out = new Float32Array(16);
      for (let c = 0; c < 4; c += 1) {
        for (let r = 0; r < 4; r += 1) {
          out[c * 4 + r] =
            a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
        }
      }
      return out;
    },

    rotationY(angle) {
      const s = Math.sin(angle), c = Math.cos(angle);
      return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
    },
  };

  /* ── colour ──────────────────────────────────────────────────── */

  /** '#D8CBB4' → linear-space rgb, because all the lighting maths is linear. */
  const hexToLinear = (hex, fallback) => {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    const value = match ? parseInt(match[1], 16) : parseInt((fallback || '#D8CBB4').slice(1), 16);
    const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    return [
      toLinear(((value >> 16) & 255) / 255),
      toLinear(((value >> 8) & 255) / 255),
      toLinear((value & 255) / 255),
    ];
  };

  /* ── GL helpers ──────────────────────────────────────────────── */

  const compile = (gl, type, source, label) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('garment3d: ' + label + ' failed to compile\n' + log);
    }
    return shader;
  };

  const program = (gl, vertexSource, fragmentSource, label) => {
    const vs = compile(gl, gl.VERTEX_SHADER, vertexSource, label + ' vertex shader');
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource, label + ' fragment shader');
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error('garment3d: ' + label + ' failed to link\n' + log);
    }

    const uniforms = {};
    const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i += 1) {
      const name = gl.getActiveUniform(prog, i).name.replace(/\[0\]$/, '');
      uniforms[name] = gl.getUniformLocation(prog, name);
    }
    return { program: prog, uniforms };
  };

  /* ── the shirt's topology ────────────────────────────────────────
   *
   * Every option moves these vertices; none of them adds or removes one. That
   * is what lets a change be morphed instead of popping: two position sets and
   * a lerp in the vertex shader.
   */

  const RES = {
    bodyRings: 64, bodySegs: 72,
    sleeveRings: 26, sleeveSegs: 26,
    collarRings: 12, collarSegs: 44,
    cuffRings: 6, cuffSegs: 26,
    placketRows: 44, placketCols: 4,
    pocketGrid: 10,
    buttons: 16, buttonSegs: 16,
  };

  /** Material id per vertex — the fragment shader shades cloth, shell and thread differently. */
  const PART = { body: 0, sleeve: 1, collar: 2, cuffL: 3, placket: 4, button: 5, pocket: 6, cuffR: 7 };

  const gridIndices = (indices, base, rows, cols, closed) => {
    const lastCol = closed ? cols : cols - 1;
    for (let r = 0; r < rows - 1; r += 1) {
      for (let c = 0; c < lastCol; c += 1) {
        const c1 = (c + 1) % cols;
        const a = base + r * cols + c;
        const b = base + r * cols + c1;
        const d = base + (r + 1) * cols + c;
        const e = base + (r + 1) * cols + c1;
        indices.push(a, d, b, b, d, e);
      }
    }
  };

  /**
   * Lay the pieces out once: vertex ranges, indices, UVs and material ids never
   * change, so they are built a single time and kept.
   */
  const buildLayout = () => {
    const parts = [];
    const indices = [];
    let cursor = 0;

    const addGrid = (name, rows, cols, closed, part) => {
      const entry = { name, part, base: cursor, rows, cols, closed, count: rows * cols };
      gridIndices(indices, cursor, rows, cols, closed);
      cursor += entry.count;
      parts.push(entry);
      return entry;
    };

    const layout = {};
    layout.body = addGrid('body', RES.bodyRings, RES.bodySegs, true, PART.body);
    layout.sleeveL = addGrid('sleeveL', RES.sleeveRings, RES.sleeveSegs, true, PART.sleeve);
    layout.sleeveR = addGrid('sleeveR', RES.sleeveRings, RES.sleeveSegs, true, PART.sleeve);
    layout.collar = addGrid('collar', RES.collarRings, RES.collarSegs, false, PART.collar);
    layout.cuffL = addGrid('cuffL', RES.cuffRings, RES.cuffSegs, true, PART.cuffL);
    layout.cuffR = addGrid('cuffR', RES.cuffRings, RES.cuffSegs, true, PART.cuffR);
    layout.placket = addGrid('placket', RES.placketRows, RES.placketCols, false, PART.placket);
    layout.pocketL = addGrid('pocketL', RES.pocketGrid, RES.pocketGrid, false, PART.pocket);
    layout.pocketR = addGrid('pocketR', RES.pocketGrid, RES.pocketGrid, false, PART.pocket);

    // Buttons: a shallow dome (centre + rim) with a short side wall, one block each.
    const segs = RES.buttonSegs;
    const perButton = 1 + segs * 3;
    layout.buttons = { base: cursor, perButton, count: RES.buttons * perButton, part: PART.button };
    for (let b = 0; b < RES.buttons; b += 1) {
      const base = cursor + b * perButton;
      const centre = base;
      const top = base + 1;              // segs — the rim of the dome
      const skirtTop = top + segs;       // segs — same rim, pushed out
      const skirtBottom = skirtTop + segs;
      for (let s = 0; s < segs; s += 1) {
        const n = (s + 1) % segs;
        indices.push(centre, top + s, top + n);
        indices.push(top + s, skirtTop + s, top + n);
        indices.push(top + n, skirtTop + s, skirtTop + n);
        indices.push(skirtTop + s, skirtBottom + s, skirtTop + n);
        indices.push(skirtTop + n, skirtBottom + s, skirtBottom + n);
      }
    }
    cursor += layout.buttons.count;
    parts.push(layout.buttons);

    const vertexCount = cursor;
    const uv = new Float32Array(vertexCount * 2);
    const part = new Float32Array(vertexCount);

    for (const entry of parts) {
      if (entry.rows === undefined) {
        for (let i = 0; i < entry.count; i += 1) part[entry.base + i] = entry.part;
        continue;
      }
      // A closed ring wraps, so its last column meets the first; an open strip
      // has to reach u = 1 instead.
      const span = entry.closed ? entry.cols : entry.cols - 1;
      for (let r = 0; r < entry.rows; r += 1) {
        for (let c = 0; c < entry.cols; c += 1) {
          const index = entry.base + r * entry.cols + c;
          uv[index * 2] = c / span;
          uv[index * 2 + 1] = r / (entry.rows - 1);
          part[index] = entry.part;
        }
      }
    }

    return { layout, indices: new Uint32Array(indices), uv, part, vertexCount };
  };

  /* ── the make-up, as numbers ─────────────────────────────────── */

  const FIT = {
    slim:      { waist: 0.845, chest: 0.985, hem: 0.90, shoulder: 1.015, drape: 0.30, fold: 0.0030 },
    tailored:  { waist: 0.895, chest: 1.000, hem: 0.95, shoulder: 1.030, drape: 0.45, fold: 0.0042 },
    relaxed:   { waist: 0.985, chest: 1.045, hem: 1.02, shoulder: 1.070, drape: 0.75, fold: 0.0068 },
    oversized: { waist: 1.075, chest: 1.130, hem: 1.10, shoulder: 1.140, drape: 1.00, fold: 0.0092 },
  };

  const SIZE_SCALE = {
    xs: 0.90, s: 0.95, m: 1.0, l: 1.06, xl: 1.12, xxl: 1.19, 'made-to-measure': 1.0,
  };

  const COLLAR = {
    classic:       { band: 0.075, point: 0.150, spread: 0.34, fall: 0.072 },
    'button-down': { band: 0.075, point: 0.130, spread: 0.46, fall: 0.066 },
    cutaway:       { band: 0.072, point: 0.098, spread: 1.05, fall: 0.060 },
    band:          { band: 0.058, point: 0.000, spread: 0.16, fall: 0.000 },
  };

  const readSpec = (raw) => {
    const spec = raw || {};
    const fit = FIT[spec.fit] || FIT.tailored;
    const collar = COLLAR[spec.collar] || COLLAR.classic;
    return {
      fit, collar,
      collarId: COLLAR[spec.collar] ? spec.collar : 'classic',
      scale: SIZE_SCALE[spec.size] === undefined ? 1 : SIZE_SCALE[spec.size],
      shortSleeve: spec.sleeve === 'short',
      frenchCuff: spec.cuff === 'french',
      noCuff: spec.cuff === 'none' || spec.sleeve === 'short',
      cuffButtons: spec.cuff === 'barrel-double' ? 2 : spec.cuff === 'none' ? 0 : 1,
      curvedHem: spec.hem !== 'straight',
      placket: spec.placket === 'hidden' ? 'hidden' : spec.placket === 'no-placket' ? 'none' : 'standard',
      pockets: spec.pocket === 'double-patch' ? 2 : spec.pocket === 'single-patch' ? 1 : 0,
      /** Heavier cloth hangs in fewer, deeper folds and takes a coarser weave. */
      weight: clamp(((spec.weightGsm || 160) - 130) / 70, 0, 1.4),
    };
  };

  /* ── the surfaces ────────────────────────────────────────────── */

  const SHOULDER_Y = 1.0;    // the shoulder seam
  const NECK_Y = 1.135;      // the top of the yoke, where the collar sits
  const YOKE_START = 0.855;  // ring fraction at which the body starts rounding over

  /** Half-width of the torso, as a multiple of the chest half-width. */
  const widthProfile = (v, fit) => {
    const stops = [
      [0.00, fit.hem], [0.18, fit.hem * 1.02], [0.34, 0.985],
      [0.52, fit.waist], [0.72, fit.chest], [0.88, fit.chest * 1.01], [1.00, fit.shoulder],
    ];
    for (let i = 0; i < stops.length - 1; i += 1) {
      const [v0, w0] = stops[i];
      const [v1, w1] = stops[i + 1];
      if (v <= v1 || i === stops.length - 2) return lerp(w0, w1, smoothstep(clamp((v - v0) / (v1 - v0), 0, 1)));
    }
    return fit.shoulder;
  };

  /** A superellipse, so the torso reads as a rounded rectangle rather than a tube. */
  const superEllipse = (theta, a, b, n) => {
    const c = Math.cos(theta), s = Math.sin(theta);
    const ex = Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
    const ez = Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
    return [a * ex, b * ez];
  };

  const CHEST_HALF = 0.300;   // half the chest width at size M, in scene units
  const DEPTH_RATIO = 0.615;  // a torso is deeper than it is round
  const NECK_A = 0.138, NECK_B = 0.112;
  const SUPER_N = 2.55;

  /** Where the sleeve leaves the body, and which way it hangs. */
  const armAt = (side, spec) => {
    const a = CHEST_HALF * spec.scale * spec.fit.shoulder;
    const angle = 0.40 + spec.fit.drape * 0.06;
    // The root sits well inside the torso so the armhole is a real join, not a
    // tube parked next to the body.
    return {
      origin: [side * a * 0.50, SHOULDER_Y * 0.895, 0],
      axis: [side * Math.sin(angle), -Math.cos(angle), 0.015],
      length: (spec.shortSleeve ? 0.40 : 0.76) * spec.scale,
      rootRadius: 0.150 * spec.scale * (0.94 + spec.fit.drape * 0.20),
      endRadius: (spec.shortSleeve ? 0.098 : 0.074) * spec.scale * (0.92 + spec.fit.drape * 0.18),
    };
  };

  /** A frame around the arm axis, so rings can be swept along it. */
  const armFrame = (axis) => {
    const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
    const d = [axis[0] / len, axis[1] / len, axis[2] / len];
    // Up is mostly +Z (the front of the sleeve), orthogonalised against the axis.
    let u = [0, 0, 1];
    const dot = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
    u = [u[0] - d[0] * dot, u[1] - d[1] * dot, u[2] - d[2] * dot];
    const ul = Math.hypot(u[0], u[1], u[2]) || 1;
    u = [u[0] / ul, u[1] / ul, u[2] / ul];
    const w = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
    return { d, u, w };
  };

  /**
   * Write one pose of the shirt into `pos`, and its ambient occlusion into `ao`.
   * Called only when the make-up changes; the frames in between are a lerp.
   */
  const shape = (spec, layout, pos, ao) => {
    const set = (i, x, y, z) => { pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z; };
    const chest = CHEST_HALF * spec.scale;
    const foldAmp = spec.fit.fold * (0.65 + 0.45 * spec.weight);
    const hemCurve = spec.curvedHem ? 0.058 * spec.scale : 0;

    /* ── body and yoke ── */
    const body = layout.body;
    for (let r = 0; r < body.rows; r += 1) {
      const t = r / (body.rows - 1);
      const inYoke = t > YOKE_START;
      const v = inYoke ? 1 : t / YOKE_START;
      const k = inYoke ? (t - YOKE_START) / (1 - YOKE_START) : 0;

      const wide = widthProfile(v, spec.fit);
      let a = chest * wide;
      let b = a * DEPTH_RATIO;
      let y = v * SHOULDER_Y;

      if (inYoke) {
        // A rounded shoulder is a quarter circle: the cloth keeps climbing the
        // torso wall first, then turns in towards the neck. Narrowing before
        // climbing is what squares the corner off.
        const phi = clamp(k, 0, 1) * (Math.PI / 2);
        const sh = Math.sin(phi);
        const sw = 1 - Math.cos(phi);
        a = lerp(a, NECK_A * spec.scale, sw);
        b = lerp(b, NECK_B * spec.scale, sw);
        y = lerp(SHOULDER_Y, NECK_Y, sh);
      }

      // Folds run deepest at the hem and die out at the chest.
      const drapeProfile = Math.pow(clamp(1 - v, 0, 1), 1.25) * (inYoke ? 0 : 1);

      // The torso is a rounded rectangle; the neck opening is nearly a circle.
      const n = lerp(SUPER_N, 2.05, inYoke ? smoothstep(k) : 0);

      for (let c = 0; c < body.cols; c += 1) {
        const theta = (c / body.cols) * TAU;
        const [ex, ez] = superEllipse(theta, a, b, n);

        const fold =
          foldAmp * drapeProfile * (Math.sin(theta * 5 + 1.3) + 0.45 * Math.sin(theta * 8.3 - 0.7) + 0.22 * Math.sin(theta * 13.7 + 2.1));
        const radial = 1 + fold / Math.max(a, 1e-4);

        let py = y;
        if (!inYoke) {
          // A curved hem rides up at the sides and dips at the front and back.
          py += hemCurve * Math.cos(2 * theta) * Math.pow(clamp(1 - v * 5.5, 0, 1), 1.4);
        }

        const index = body.base + r * body.cols + c;
        set(index, ex * radial, py, ez * radial);

        const armpit = Math.pow(clamp(1 - Math.abs(Math.cos(theta)), 0, 1), 0.6);
        const nearArm = clamp((v - 0.72) / 0.28, 0, 1) * (1 - armpit);
        const foldValley = clamp(0.5 - 0.5 * Math.sin(theta * 5 + 1.3), 0, 1) * drapeProfile;
        ao[index] = clamp(1 - 0.34 * nearArm - 0.22 * foldValley - 0.18 * (inYoke ? smoothstep(k) : 0), 0.25, 1);
      }
    }

    /* ── sleeves and cuffs ── */
    for (const [key, side, cuffKey] of [['sleeveL', -1, 'cuffL'], ['sleeveR', 1, 'cuffR']]) {
      const sleeve = layout[key];
      const arm = armAt(side, spec);
      const frame = armFrame(arm.axis);
      const cuffWidth = spec.noCuff ? 0 : (spec.frenchCuff ? 0.085 : 0.055) * spec.scale;

      for (let r = 0; r < sleeve.rows; r += 1) {
        const t = r / (sleeve.rows - 1);
        const radius = lerp(arm.rootRadius, arm.endRadius, smoothstep(clamp((t - 0.16) / 0.84, 0, 1)));
        // A little bend forward, and cloth gathering just above the cuff.
        const bend = 0.055 * spec.scale * t * t;
        const gather = spec.noCuff ? 0 : 0.018 * spec.scale * Math.pow(clamp((t - 0.72) / 0.28, 0, 1), 2);
        const along = arm.length * t;
        const cx = arm.origin[0] + frame.d[0] * along;
        const cy = arm.origin[1] + frame.d[1] * along;
        const cz = arm.origin[2] + frame.d[2] * along + bend;

        for (let c = 0; c < sleeve.cols; c += 1) {
          const phi = (c / sleeve.cols) * TAU;
          const wrinkle =
            (0.012 + 0.016 * spec.fit.drape) * spec.scale * Math.sin(phi * 5 + t * 9) * Math.pow(t, 1.4) * (spec.shortSleeve ? 0.4 : 1);
          const rr = radius + wrinkle + gather;
          const ux = Math.cos(phi) * rr, wz = Math.sin(phi) * rr;
          const index = sleeve.base + r * sleeve.cols + c;
          set(
            index,
            cx + frame.u[0] * ux + frame.w[0] * wz,
            cy + frame.u[1] * ux + frame.w[1] * wz,
            cz + frame.u[2] * ux + frame.w[2] * wz,
          );
          ao[index] = clamp(1 - 0.40 * Math.pow(clamp(1 - t * 4, 0, 1), 1.2) - 0.10 * clamp(-Math.sin(phi), 0, 1), 0.28, 1);
        }
      }

      // The cuff is a band wrapped around the very end of the sleeve; with no
      // cuff it collapses onto that end ring and disappears.
      const cuff = layout[cuffKey];
      const endRadius = arm.endRadius + 0.0015 * spec.scale;
      for (let r = 0; r < cuff.rows; r += 1) {
        const t = r / (cuff.rows - 1);
        const along = arm.length - cuffWidth * (1 - t);
        const cx = arm.origin[0] + frame.d[0] * along;
        const cy = arm.origin[1] + frame.d[1] * along;
        const cz = arm.origin[2] + frame.d[2] * along + 0.055 * spec.scale * Math.pow(along / Math.max(arm.length, 1e-4), 2);
        // A French cuff turns back on itself, so it is fuller at the opening.
        const flare = spec.frenchCuff ? 1 + 0.20 * Math.pow(t, 1.6) : 1 + 0.055 * Math.pow(t, 1.4);
        for (let c = 0; c < cuff.cols; c += 1) {
          const phi = (c / cuff.cols) * TAU;
          const rr = endRadius * flare;
          const ux = Math.cos(phi) * rr, wz = Math.sin(phi) * rr;
          const index = cuff.base + r * cuff.cols + c;
          set(
            index,
            cx + frame.u[0] * ux + frame.w[0] * wz,
            cy + frame.u[1] * ux + frame.w[1] * wz,
            cz + frame.u[2] * ux + frame.w[2] * wz,
          );
          ao[index] = spec.noCuff ? 1 : clamp(0.82 + 0.18 * t, 0, 1);
        }
      }
    }

    /* ── collar ── */
    {
      const collar = layout.collar;
      const gapHalf = 0.255;
      const arcStart = Math.PI / 2 + gapHalf;
      const arcSpan = TAU - 2 * gapHalf;
      const bandFrac = 0.42;
      const na = NECK_A * spec.scale, nb = NECK_B * spec.scale;
      const { band, point, spread, fall } = spec.collar;

      for (let r = 0; r < collar.rows; r += 1) {
        const k = r / (collar.rows - 1);
        for (let c = 0; c < collar.cols; c += 1) {
          const s = c / (collar.cols - 1);
          const theta = arcStart + s * arcSpan;
          // The collar points are the two ends of the arc, either side of the gap.
          const pf = Math.max(
            smoothstep(clamp(1 - s / 0.14, 0, 1)),
            smoothstep(clamp((s - 0.86) / 0.14, 0, 1)),
          );

          let y, radial, push;
          if (k <= bandFrac) {
            const u = k / bandFrac;
            y = NECK_Y + band * spec.scale * u;
            radial = 1 + 0.26 * spread * u;
            push = 0;
          } else {
            const u = (k - bandFrac) / (1 - bandFrac);
            y = NECK_Y + band * spec.scale - (fall + point * pf) * spec.scale * u;
            radial = 1 + 0.26 * spread + (0.34 + 0.62 * spread) * u;
            push = 0.055 * spec.scale * pf * u * u;
          }

          const index = collar.base + r * collar.cols + c;
          set(index, na * radial * Math.cos(theta), y, nb * radial * Math.sin(theta) + push);
          ao[index] = clamp(0.62 + 0.38 * k, 0, 1);
        }
      }
    }

    /* ── placket ── */
    const placketOffset = spec.placket === 'standard' ? 0.0058 : spec.placket === 'hidden' ? 0.0024 : 0.0007;
    const placketHalf = (spec.placket === 'standard' ? 0.016 : spec.placket === 'hidden' ? 0.014 : 0.011) * spec.scale;
    {
      const placket = layout.placket;
      const topY = SHOULDER_Y * 0.975;
      const bottomY = (spec.curvedHem ? -hemCurve : 0) + 0.012;
      for (let r = 0; r < placket.rows; r += 1) {
        const t = r / (placket.rows - 1);
        const y = lerp(topY, bottomY, t);
        const v = clamp(y / SHOULDER_Y, 0, 1);
        const a = chest * widthProfile(v, spec.fit);
        const b = a * DEPTH_RATIO;
        for (let c = 0; c < placket.cols; c += 1) {
          const u = c / (placket.cols - 1);
          const x = lerp(-placketHalf, placketHalf, u);
          // Round the strip slightly so it catches the light like a real fold.
          const crown = Math.sin(u * Math.PI) * placketOffset * 0.55;
          const index = placket.base + r * placket.cols + c;
          set(index, x, y, b + placketOffset + crown);
          ao[index] = clamp(0.80 + 0.20 * Math.sin(u * Math.PI), 0, 1);
        }
      }
    }

    /* ── patch pockets ── */
    {
      const surfaceZ = (x, v) => {
        const a = chest * widthProfile(v, spec.fit);
        const b = a * DEPTH_RATIO;
        const cosT = clamp(Math.pow(clamp(Math.abs(x) / Math.max(a, 1e-4), 0, 1), SUPER_N / 2), 0, 1);
        const theta = Math.acos(cosT);
        return b * Math.pow(Math.max(Math.sin(theta), 0), 2 / SUPER_N);
      };

      const pocketSpec = [
        { entry: layout.pocketL, side: -1, on: spec.pockets >= 1 },
        { entry: layout.pocketR, side: 1, on: spec.pockets >= 2 },
      ];

      for (const { entry, side, on } of pocketSpec) {
        const centreX = side * 0.128 * spec.scale;
        const centreY = 0.665 * SHOULDER_Y;
        const halfW = on ? 0.043 * spec.scale : 0;
        const halfH = on ? 0.050 * spec.scale : 0;
        for (let r = 0; r < entry.rows; r += 1) {
          const ty = r / (entry.rows - 1);
          for (let c = 0; c < entry.cols; c += 1) {
            const tx = c / (entry.cols - 1);
            // The bottom corners are clipped, the way a patch pocket is cut.
            const taper = clamp((ty - 0.78) / 0.22, 0, 1) * (Math.abs(tx - 0.5) * 2);
            const x = centreX + lerp(-halfW, halfW, tx) * (1 - taper * 0.55);
            const y = centreY + lerp(halfH, -halfH, ty);
            const v = clamp(y / SHOULDER_Y, 0, 1);
            const index = entry.base + r * entry.cols + c;
            set(index, x, y, surfaceZ(x, v) + (on ? 0.0048 * spec.scale : 0));
            ao[index] = on ? clamp(0.72 + 0.28 * (1 - ty), 0, 1) : 1;
          }
        }
      }
    }

    /* ── buttons ── */
    {
      const slots = [];
      const frontZ = (y) => {
        const v = clamp(y / SHOULDER_Y, 0, 1);
        const a = chest * widthProfile(v, spec.fit);
        return a * DEPTH_RATIO;
      };

      if (spec.placket !== 'hidden') {
        for (let i = 0; i < 6; i += 1) {
          const y = lerp(0.915, 0.235, i / 5) * SHOULDER_Y;
          slots.push({ p: [0, y, frontZ(y) + placketOffset + 0.0042 * spec.scale], n: [0, 0.06, 1], r: 0.0132 * spec.scale });
        }
      }

      if (spec.collarId === 'button-down') {
        const na = NECK_A * spec.scale, nb = NECK_B * spec.scale;
        const radial = 1 + 0.18 * spec.collar.spread + (0.30 + 0.95 * spec.collar.spread) * 0.92;
        for (const sign of [-1, 1]) {
          const theta = Math.PI / 2 + sign * 0.42;
          const y = NECK_Y + spec.collar.band * spec.scale - (spec.collar.fall + spec.collar.point) * spec.scale * 0.88;
          slots.push({
            p: [na * radial * Math.cos(theta), y, nb * radial * Math.sin(theta) + 0.020 * spec.scale],
            n: [Math.cos(theta) * 0.4, 0.15, 1],
            r: 0.0082 * spec.scale,
          });
        }
      }

      for (const side of [-1, 1]) {
        const arm = armAt(side, spec);
        const frame = armFrame(arm.axis);
        const cuffWidth = (spec.frenchCuff ? 0.085 : 0.055) * spec.scale;
        for (let i = 0; i < spec.cuffButtons; i += 1) {
          const along = arm.length - cuffWidth * (0.45 + i * 0.28);
          const radius = arm.endRadius * 1.06 + 0.006 * spec.scale;
          const phi = -0.35;
          const ux = Math.cos(phi) * radius, wz = Math.sin(phi) * radius;
          slots.push({
            p: [
              arm.origin[0] + frame.d[0] * along + frame.u[0] * ux + frame.w[0] * wz,
              arm.origin[1] + frame.d[1] * along + frame.u[1] * ux + frame.w[1] * wz,
              arm.origin[2] + frame.d[2] * along + frame.u[2] * ux + frame.w[2] * wz + 0.055 * spec.scale,
            ],
            n: [frame.u[0] * Math.cos(phi) + frame.w[0] * Math.sin(phi),
                frame.u[1] * Math.cos(phi) + frame.w[1] * Math.sin(phi),
                frame.u[2] * Math.cos(phi) + frame.w[2] * Math.sin(phi)],
            r: 0.0098 * spec.scale,
          });
        }
      }

      const segs = RES.buttonSegs;
      const per = layout.buttons.perButton;
      for (let b = 0; b < RES.buttons; b += 1) {
        const base = layout.buttons.base + b * per;
        const slot = slots[b];
        if (!slot) {
          // Unused slots collapse to a point and draw nothing.
          for (let i = 0; i < per; i += 1) { set(base + i, 0, -9, 0); ao[base + i] = 1; }
          continue;
        }

        const nl = Math.hypot(slot.n[0], slot.n[1], slot.n[2]) || 1;
        const n = [slot.n[0] / nl, slot.n[1] / nl, slot.n[2] / nl];
        let helper = Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
        let t1 = [
          helper[1] * n[2] - helper[2] * n[1],
          helper[2] * n[0] - helper[0] * n[2],
          helper[0] * n[1] - helper[1] * n[0],
        ];
        const t1l = Math.hypot(t1[0], t1[1], t1[2]) || 1;
        t1 = [t1[0] / t1l, t1[1] / t1l, t1[2] / t1l];
        const t2 = [n[1] * t1[2] - n[2] * t1[1], n[2] * t1[0] - n[0] * t1[2], n[0] * t1[1] - n[1] * t1[0]];

        const at = (radius, lift) => (angle) => [
          slot.p[0] + (t1[0] * Math.cos(angle) + t2[0] * Math.sin(angle)) * radius + n[0] * lift,
          slot.p[1] + (t1[1] * Math.cos(angle) + t2[1] * Math.sin(angle)) * radius + n[1] * lift,
          slot.p[2] + (t1[2] * Math.cos(angle) + t2[2] * Math.sin(angle)) * radius + n[2] * lift,
        ];

        const R = slot.r;
        set(base, slot.p[0] + n[0] * R * 0.26, slot.p[1] + n[1] * R * 0.26, slot.p[2] + n[2] * R * 0.26);
        ao[base] = 1;
        const rim = at(R, R * 0.06);
        const skirt = at(R * 0.98, -R * 0.12);
        for (let s = 0; s < segs; s += 1) {
          const angle = (s / segs) * TAU;
          const p1 = rim(angle), p2 = skirt(angle);
          set(base + 1 + s, p1[0], p1[1], p1[2]);
          set(base + 1 + segs + s, p1[0], p1[1], p1[2]);
          set(base + 1 + segs * 2 + s, p2[0], p2[1], p2[2]);
          ao[base + 1 + s] = 1;
          ao[base + 1 + segs + s] = 0.9;
          ao[base + 1 + segs * 2 + s] = 0.62;
        }
      }
    }
  };

  /** Smooth normals, accumulated from the faces that share each vertex. */
  const computeNormals = (pos, indices, out) => {
    out.fill(0);
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      out[a] += nx; out[a + 1] += ny; out[a + 2] += nz;
      out[b] += nx; out[b + 1] += ny; out[b + 2] += nz;
      out[c] += nx; out[c + 1] += ny; out[c + 2] += nz;
    }
    for (let i = 0; i < out.length; i += 3) {
      const len = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
      out[i] /= len; out[i + 1] /= len; out[i + 2] /= len;
    }
  };

  /* ── shaders ─────────────────────────────────────────────────── */

  const GARMENT_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosA;
layout(location = 1) in vec3 aNormalA;
layout(location = 2) in vec3 aPosB;
layout(location = 3) in vec3 aNormalB;
layout(location = 4) in vec2 aUV;
layout(location = 5) in float aAO;
layout(location = 6) in float aPart;

uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
uniform float uMorph;
uniform float uTime;
uniform float uLife;

out vec3 vWorld;
out vec3 vNormal;
out vec2 vUV;
out float vAO;
out float vPart;

void main() {
  vec3 p = mix(aPosA, aPosB, uMorph);
  vec3 n = normalize(mix(aNormalA, aNormalB, uMorph));

  // The shirt is alive: it breathes at the chest and the hem drifts.
  float h = clamp(p.y / 1.14, 0.0, 1.0);
  float hang = (1.0 - h) * (1.0 - h);
  p.x += sin(uTime * 0.85 + p.y * 2.3) * 0.0065 * hang * uLife;
  p.z += sin(uTime * 0.67 + p.y * 1.9 + 1.7) * 0.0045 * hang * uLife;
  float breathe = sin(uTime * 0.52) * 0.0042 * smoothstep(0.30, 0.86, h) * uLife;
  p.xz *= 1.0 + breathe;

  vec4 world = uModel * vec4(p, 1.0);
  vWorld = world.xyz;
  vNormal = mat3(uModel) * n;
  vUV = aUV;
  vAO = aAO;
  vPart = aPart;
  gl_Position = uProj * uView * world;
}`;

  const GARMENT_FS = `#version 300 es
precision highp float;

in vec3 vWorld;
in vec3 vNormal;
in vec2 vUV;
in float vAO;
in float vPart;

uniform vec3 uCamera;
uniform vec3 uCloth;
uniform vec3 uButton;
uniform vec3 uThread;
uniform float uWeaveScale;
uniform float uWeaveDepth;
uniform float uPlacketMode;
uniform float uButtonGloss;
uniform sampler2D uDecal;
uniform vec4 uDecalRect;
uniform float uDecalPart;

out vec4 fragColor;

const float PI = 3.141592653589793;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float ggx(vec3 N, vec3 V, vec3 L, float rough) {
  vec3 H = normalize(V + L);
  float a = max(rough * rough, 1e-3);
  float a2 = a * a;
  float ndh = max(dot(N, H), 0.0);
  float ndv = max(dot(N, V), 1e-4);
  float ndl = max(dot(N, L), 0.0);
  float d = ndh * ndh * (a2 - 1.0) + 1.0;
  d = a2 / (PI * d * d);
  float k = a * 0.5;
  float gv = ndv / (ndv * (1.0 - k) + k);
  float gl = ndl / (ndl * (1.0 - k) + k);
  return d * gv * gl;
}

/** A soft, broad lobe at grazing angles — what makes cloth read as cloth. */
float sheenLobe(vec3 N, vec3 V, vec3 L) {
  vec3 H = normalize(V + L);
  float ndh = max(dot(N, H), 0.0);
  float inv = 1.0 - ndh * ndh;
  return pow(max(inv, 0.0), 6.0) * max(dot(N, L), 0.0);
}

void main() {
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(uCamera - vWorld);
  float dist = length(uCamera - vWorld);

  bool isButton = abs(vPart - 5.0) < 0.5;
  bool isCollar = abs(vPart - 2.0) < 0.5 || abs(vPart - 3.0) < 0.5 || abs(vPart - 7.0) < 0.5;
  bool isPlacket = abs(vPart - 4.0) < 0.5;

  vec3 base = uCloth;
  float rough = 0.82;
  float sheenStrength = 0.55;
  float ao = vAO;

  // A tangent frame built from screen derivatives, so the weave can be lit.
  vec3 dp1 = dFdx(vWorld), dp2 = dFdy(vWorld);
  vec2 du1 = dFdx(vUV), du2 = dFdy(vUV);
  vec3 T = normalize(dp1 * du2.y - dp2 * du1.y + 1e-8);
  vec3 B = normalize(cross(N, T));

  if (isButton) {
    base = uButton;
    rough = mix(0.34, 0.11, uButtonGloss);
    sheenStrength = 0.0;
    // Shell and horn are not flat: a little swirl in the normal sells them.
    float swirl = vnoise(vUV * 40.0 + vWorld.xy * 18.0);
    N = normalize(N + (T * (swirl - 0.5) + B * (vnoise(vUV * 33.0) - 0.5)) * 0.35 * uButtonGloss);
  } else {
    // ── the weave ──
    // Each piece covers a different amount of cloth per unit of UV, so the
    // thread count is corrected per part to keep the weave one density.
    float density = 1.0;
    if (abs(vPart - 1.0) < 0.5) density = 0.42;        // sleeves
    else if (abs(vPart - 2.0) < 0.5) density = 0.30;   // collar
    else if (abs(vPart - 3.0) < 0.5 || abs(vPart - 7.0) < 0.5) density = 0.16;
    else if (abs(vPart - 4.0) < 0.5) density = 0.10;   // placket
    else if (abs(vPart - 6.0) < 0.5) density = 0.14;   // pockets

    float S = uWeaveScale * density;
    vec2 w = vUV * vec2(S, S * 0.72);
    float checker = mod(floor(w.x) + floor(w.y), 2.0);
    vec2 f = fract(w);
    float hu = sin(f.x * PI);
    float hv = sin(f.y * PI);
    float height = mix(hv, hu, checker);

    // Weave detail has to fade with distance or it turns into noise.
    float fade = 1.0 - smoothstep(0.85, 2.4, dist);
    float dhx = mix(0.0, PI * cos(f.x * PI), checker);
    float dhy = mix(PI * cos(f.y * PI), 0.0, checker);
    N = normalize(N - (T * dhx + B * dhy) * uWeaveDepth * fade);

    // Linen is slubby: thick and thin threads, and the odd heavier pick.
    float slub = vnoise(vUV * vec2(S * 0.28, S * 0.09));
    float slub2 = vnoise(vUV * vec2(S * 0.9, S * 0.04) + 13.0);
    base *= 0.90 + 0.14 * slub + 0.06 * slub2;
    base *= 0.88 + 0.12 * height * fade;
    ao *= 0.94 + 0.06 * height;

    if (isCollar) { rough = 0.74; base *= 1.035; }

    if (isPlacket && uPlacketMode > 0.5) {
      // Two rows of topstitching down the placket.
      float edge = min(smoothstep(0.10, 0.16, vUV.x), smoothstep(0.90, 0.84, vUV.x));
      float line = max(
        1.0 - smoothstep(0.012, 0.030, abs(vUV.x - 0.15)),
        1.0 - smoothstep(0.012, 0.030, abs(vUV.x - 0.85))
      );
      float dash = step(0.38, fract(vUV.y * 130.0));
      base = mix(base, base * 0.58, line * dash);
      base *= 0.97 + 0.03 * edge;
    }
  }

  // ── the monogram, embroidered where the shopper asked for it ──
  if (abs(vPart - uDecalPart) < 0.5) {
    vec2 d = (vUV - uDecalRect.xy) / max(uDecalRect.zw - uDecalRect.xy, vec2(1e-4));
    if (d.x > 0.0 && d.x < 1.0 && d.y > 0.0 && d.y < 1.0) {
      float ink = texture(uDecal, vec2(1.0 - d.x, 1.0 - d.y)).a;
      if (ink > 0.01) {
        base = mix(base, uThread, ink);
        rough = mix(rough, 0.55, ink);
        sheenStrength = mix(sheenStrength, 1.25, ink);
        // Satin stitch stands proud of the cloth.
        N = normalize(N + (T * dFdx(ink) + B * dFdy(ink)) * -42.0);
      }
    }
  }

  // ── a three-point studio rig ──
  vec3 lights[3];
  vec3 tints[3];
  float power[3];
  lights[0] = normalize(vec3(-0.62, 0.80, 0.68));   // key, high and camera-left
  lights[1] = normalize(vec3(0.86, 0.18, 0.42));    // fill, low and cool
  lights[2] = normalize(vec3(0.20, 0.46, -0.98));   // rim, behind
  tints[0] = vec3(1.00, 0.955, 0.895);
  tints[1] = vec3(0.70, 0.79, 0.96);
  tints[2] = vec3(1.00, 0.93, 0.85);
  power[0] = 2.15;
  power[1] = 0.36;
  power[2] = 0.95;

  vec3 lit = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    vec3 L = lights[i];
    vec3 radiance = tints[i] * power[i];

    // Wrapped diffuse: cloth has no hard terminator.
    float wrap = isButton ? 0.04 : 0.30;
    float ndl = clamp((dot(N, L) + wrap) / (1.0 + wrap), 0.0, 1.0);

    lit += base * ndl * radiance / PI;
    lit += ggx(N, V, L, rough) * radiance * (isButton ? 0.85 : 0.10);
    lit += sheenLobe(N, V, L) * radiance * sheenStrength * 0.16 * (base * 0.5 + 0.5);

    // Light coming through the linen from behind.
    if (!isButton) {
      float through = pow(clamp(dot(-N, L), 0.0, 1.0), 2.4);
      lit += base * through * radiance * 0.085;
    }
  }

  // Hemispheric ambient: a bright backdrop above, its bounce below.
  vec3 sky = vec3(0.225, 0.238, 0.258);
  vec3 bounce = vec3(0.105, 0.095, 0.082);
  vec3 ambient = mix(bounce, sky, N.y * 0.5 + 0.5);
  lit += base * ambient * ao;

  // Edge fresnel, so the silhouette lifts off the backdrop.
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
  lit += fres * (isButton ? 0.16 : 0.05) * vec3(1.0, 0.98, 0.95) * ao;

  fragColor = vec4(lit, 1.0);
}`;

  /** The shadow caster: the same pose, flattened onto the backdrop. */
  const SHADOW_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosA;
layout(location = 2) in vec3 aPosB;

uniform mat4 uModel;
uniform mat4 uShadowProj;
uniform vec3 uLight;
uniform float uMorph;
uniform float uTime;
uniform float uLife;
uniform float uGroundY;

void main() {
  vec3 p = mix(aPosA, aPosB, uMorph);
  float h = clamp(p.y / 1.14, 0.0, 1.0);
  float hang = (1.0 - h) * (1.0 - h);
  p.x += sin(uTime * 0.85 + p.y * 2.3) * 0.0065 * hang * uLife;
  p.z += sin(uTime * 0.67 + p.y * 1.9 + 1.7) * 0.0045 * hang * uLife;

  vec3 world = (uModel * vec4(p, 1.0)).xyz;
  // Slide the point down the light ray until it lands on the backdrop.
  float t = (world.y - uGroundY) / max(uLight.y, 0.15);
  vec3 onGround = vec3(world.x - uLight.x * t, uGroundY, world.z - uLight.z * t);
  gl_Position = uShadowProj * vec4(onGround, 1.0);
}`;

  const SHADOW_FS = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() { fragColor = vec4(1.0); }`;

  const GROUND_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
uniform mat4 uProj;
uniform mat4 uView;
uniform float uGroundY;
uniform float uExtent;
out vec3 vWorld;
void main() {
  vWorld = vec3(aCorner.x * uExtent, uGroundY, aCorner.y * uExtent);
  gl_Position = uProj * uView * vec4(vWorld, 1.0);
}`;

  const GROUND_FS = `#version 300 es
precision highp float;
in vec3 vWorld;
uniform sampler2D uShadow;
uniform float uExtent;
uniform vec3 uBackdrop;
out vec4 fragColor;

void main() {
  vec2 uv = (vWorld.xz / uExtent) * 0.5 + 0.5;

  // A wide blur turns the hard cast into a soft studio shadow.
  float shade = 0.0;
  float total = 0.0;
  for (int y = -3; y <= 3; y++) {
    for (int x = -3; x <= 3; x++) {
      vec2 offset = vec2(float(x), float(y)) * 0.0085;
      float w = exp(-dot(offset, offset) * 3200.0);
      shade += texture(uShadow, uv + offset).r * w;
      total += w;
    }
  }
  shade /= max(total, 1e-4);

  float radial = 1.0 - smoothstep(0.15, 0.85, length(vWorld.xz) / uExtent);
  vec3 colour = uBackdrop * (0.68 + 0.42 * radial);
  colour *= 1.0 - shade * 0.78;
  fragColor = vec4(colour, 1.0);
}`;

  const POST_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
out vec2 vUV;
void main() {
  vUV = aCorner * 0.5 + 0.5;
  gl_Position = vec4(aCorner, 0.0, 1.0);
}`;

  const POST_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uScene;
uniform vec2 uTexel;
uniform float uTime;
uniform float uBloom;
out vec4 fragColor;

/** Narkowicz's ACES fit — cheap, and it keeps highlights from going chalky. */
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  // Resolve the supersampled target with a small box, then bloom the highlights.
  vec3 colour = vec3(0.0);
  colour += texture(uScene, vUV + uTexel * vec2(-0.25, -0.25)).rgb;
  colour += texture(uScene, vUV + uTexel * vec2(0.25, -0.25)).rgb;
  colour += texture(uScene, vUV + uTexel * vec2(-0.25, 0.25)).rgb;
  colour += texture(uScene, vUV + uTexel * vec2(0.25, 0.25)).rgb;
  colour *= 0.25;

  vec3 bloom = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    float a = float(i) * 0.3926991;
    float r = 2.0 + float(i % 4) * 3.5;
    vec3 s = texture(uScene, vUV + vec2(cos(a), sin(a)) * uTexel * r).rgb;
    bloom += max(s - 0.85, vec3(0.0));
  }
  colour += bloom * (uBloom / 16.0);

  colour = aces(colour * 1.05);
  colour = pow(colour, vec3(1.0 / 2.2));

  // A touch of lens vignette and grain, so it reads as a photograph.
  vec2 d = vUV - 0.5;
  colour *= 1.0 - dot(d, d) * 0.42;
  float grain = fract(sin(dot(vUV * 1024.0 + uTime, vec2(12.9898, 78.233))) * 43758.5453);
  colour += (grain - 0.5) * 0.012;

  fragColor = vec4(colour, 1.0);
}`;

  /* ── the monogram, drawn to a texture ────────────────────────── */

  const FONT_STACK = {
    'block-sans': '700 108px "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif',
    'classic-serif': '500 112px "Bodoni Moda", Didot, Georgia, serif',
    script: 'italic 600 118px "Snell Roundhand", "Apple Chancery", "Segoe Script", cursive',
  };

  /** Where a monogram lands, as a UV rectangle on one of the pieces. */
  const DECAL_PLACEMENT = {
    'chest-left': { part: PART.body, rect: [0.268, 0.530, 0.352, 0.612] },
    'hem-left': { part: PART.body, rect: [0.268, 0.095, 0.344, 0.170] },
    'collar-inner': { part: PART.collar, rect: [0.435, 0.060, 0.565, 0.330] },
    'cuff-left': { part: PART.cuffL, rect: [0.845, 0.240, 0.975, 0.760] },
    'cuff-right': { part: PART.cuffR, rect: [0.845, 0.240, 0.975, 0.760] },
  };

  const drawMonogram = (canvas, text, font) => {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!text) return;
    ctx.font = FONT_STACK[font] || FONT_STACK['block-sans'];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    // Drawn white into the alpha channel; the shader tints it with the thread.
    const maxWidth = canvas.width * 0.84;
    ctx.save();
    const measured = ctx.measureText(text).width;
    if (measured > maxWidth) ctx.scale(maxWidth / measured, 1);
    ctx.fillText(text, (canvas.width / 2) * (measured > maxWidth ? measured / maxWidth : 1), canvas.height / 2);
    ctx.restore();
  };

  /* ── the view ────────────────────────────────────────────────── */

  const createGarmentView = (canvas, options) => {
    const opts = options || {};
    let gl;
    try {
      gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: true, powerPreference: 'high-performance' });
    } catch (error) {
      gl = null;
    }
    if (!gl) return { supported: false, update() {}, destroy() {} };

    const hdr = gl.getExtension('EXT_color_buffer_float');
    const reduceMotion = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const mesh = buildLayout();
    const vertexCount = mesh.vertexCount;
    const posA = new Float32Array(vertexCount * 3);
    const posB = new Float32Array(vertexCount * 3);
    const normA = new Float32Array(vertexCount * 3);
    const normB = new Float32Array(vertexCount * 3);
    const aoA = new Float32Array(vertexCount);
    const aoB = new Float32Array(vertexCount);
    const scratchPos = new Float32Array(vertexCount * 3);

    /* programs */
    const garment = program(gl, GARMENT_VS, GARMENT_FS, 'garment');
    const shadow = program(gl, SHADOW_VS, SHADOW_FS, 'shadow');
    const ground = program(gl, GROUND_VS, GROUND_FS, 'backdrop');
    const post = program(gl, POST_VS, POST_FS, 'post');

    /* buffers */
    const buffer = (data, usage) => {
      const id = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, id);
      gl.bufferData(gl.ARRAY_BUFFER, data, usage || gl.STATIC_DRAW);
      return id;
    };

    const bufPosA = buffer(posA, gl.DYNAMIC_DRAW);
    const bufNormA = buffer(normA, gl.DYNAMIC_DRAW);
    const bufPosB = buffer(posB, gl.DYNAMIC_DRAW);
    const bufNormB = buffer(normB, gl.DYNAMIC_DRAW);
    const bufUV = buffer(mesh.uv);
    const bufAO = buffer(aoB, gl.DYNAMIC_DRAW);
    const bufPart = buffer(mesh.part);

    const indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

    const garmentVAO = gl.createVertexArray();
    gl.bindVertexArray(garmentVAO);
    const attrib = (location, buf, size) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    };
    attrib(0, bufPosA, 3);
    attrib(1, bufNormA, 3);
    attrib(2, bufPosB, 3);
    attrib(3, bufNormB, 3);
    attrib(4, bufUV, 2);
    attrib(5, bufAO, 1);
    attrib(6, bufPart, 1);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bindVertexArray(null);

    const quadData = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    const quadBuffer = buffer(quadData);
    const quadVAO = gl.createVertexArray();
    gl.bindVertexArray(quadVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    /* targets */
    const makeTexture = (width, height, internal, format, type, filter) => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    };

    const SHADOW_SIZE = 512;
    const shadowTex = makeTexture(SHADOW_SIZE, SHADOW_SIZE, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
    const shadowFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, shadowTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    let sceneTex = null, sceneFBO = null, sceneDepth = null;
    let renderWidth = 0, renderHeight = 0;

    const allocateScene = (width, height) => {
      if (sceneTex) { gl.deleteTexture(sceneTex); gl.deleteFramebuffer(sceneFBO); gl.deleteRenderbuffer(sceneDepth); }
      sceneTex = hdr
        ? makeTexture(width, height, gl.RGBA16F, gl.RGBA, gl.FLOAT, gl.LINEAR)
        : makeTexture(width, height, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
      sceneDepth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, sceneDepth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
      sceneFBO = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFBO);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, sceneDepth);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      renderWidth = width;
      renderHeight = height;
    };

    /* the monogram texture */
    const decalCanvas = global.document.createElement('canvas');
    decalCanvas.width = 384;
    decalCanvas.height = 320;
    const decalTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, decalTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    /* ── state ── */
    const EXTENT = 3.2;
    const GROUND_Y = -0.46;
    const MORPH_MS = 620;

    const state = {
      spec: readSpec(opts.spec || {}),
      cloth: hexToLinear(opts.cloth || '#D8CBB4'),
      button: hexToLinear(opts.button || '#E8E0CF'),
      thread: hexToLinear('#1F2A44'),
      backdrop: hexToLinear(opts.backdrop || '#EDEAE3'),
      weaveScale: 380,
      weaveDepth: 0.016,
      buttonGloss: 0.35,
      placketMode: 1,
      decalPart: -1,
      decalRect: [0, 0, 0, 0],
      morph: 1,
      morphStart: -1,
      seeded: false,
    };

    const camera = {
      azimuth: 0.42, elevation: 0.21, radius: 2.92, targetY: 0.50,
      spin: !reduceMotion, lastInteraction: -1e9,
    };

    const shadowProj = new Float32Array([
      1 / EXTENT, 0, 0, 0,
      0, 0, 0, 0,
      0, 1 / EXTENT, 0, 0,
      0, 0, 0, 1,
    ]);

    const upload = (buf, data) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    };

    const easedMorph = () => (state.morphStart < 0 ? 1 : easeInOut(clamp(state.morph, 0, 1)));

    /** Re-pose the shirt, morphing from wherever it currently is. */
    const repose = (spec) => {
      if (!state.seeded) {
        shape(spec, mesh.layout, posB, aoB);
        computeNormals(posB, mesh.indices, normB);
        posA.set(posB);
        normA.set(normB);
        aoA.set(aoB);
        state.seeded = true;
        state.morph = 1;
        state.morphStart = -1;
      } else {
        // Freeze the current in-between pose as the new starting point.
        const t = easedMorph();
        for (let i = 0; i < scratchPos.length; i += 1) scratchPos[i] = lerp(posA[i], posB[i], t);
        posA.set(scratchPos);
        computeNormals(posA, mesh.indices, normA);
        shape(spec, mesh.layout, posB, aoB);
        computeNormals(posB, mesh.indices, normB);
        state.morph = 0;
        state.morphStart = global.performance.now();
      }

      upload(bufPosA, posA);
      upload(bufNormA, normA);
      upload(bufPosB, posB);
      upload(bufNormB, normB);
      upload(bufAO, aoB);
    };

    const BUTTON_GLOSS = { 'mother-of-pearl': 1.0, 'horn-dark': 0.72, 'corozo-natural': 0.34 };

    const update = (raw) => {
      const spec = raw || {};
      state.spec = readSpec(spec);
      state.cloth = hexToLinear(spec.fabricSwatch, '#D8CBB4');
      state.button = hexToLinear(spec.buttonSwatch, '#E8E0CF');
      state.buttonGloss = BUTTON_GLOSS[spec.buttons] === undefined ? 0.4 : BUTTON_GLOSS[spec.buttons];
      state.placketMode = state.spec.placket === 'standard' ? 1 : 0;
      // A heavier cloth reads as a coarser, deeper weave.
      state.weaveScale = lerp(430, 290, clamp(state.spec.weight / 1.4, 0, 1));
      state.weaveDepth = lerp(0.013, 0.022, clamp(state.spec.weight / 1.4, 0, 1));

      const mono = spec.monogram;
      const placement = mono && mono.text ? DECAL_PLACEMENT[mono.position] : null;
      if (placement) {
        drawMonogram(decalCanvas, mono.text, mono.font);
        gl.bindTexture(gl.TEXTURE_2D, decalTex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, decalCanvas);
        state.decalPart = placement.part;
        state.decalRect = placement.rect;
        state.thread = hexToLinear(mono.threadSwatch, '#1F2A44');
      } else {
        state.decalPart = -1;
      }

      repose(state.spec);
    };

    /* ── sizing ── */
    let cssWidth = 1, cssHeight = 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      cssWidth = Math.max(1, Math.round(rect.width));
      cssHeight = Math.max(1, Math.round(rect.height));
      const dpr = clamp(global.devicePixelRatio || 1, 1, 2);
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);

      // Render above the display resolution, then resolve in the post pass.
      const budget = 3.6e6;
      let scale = dpr * 1.35;
      while (cssWidth * scale * cssHeight * scale > budget && scale > 1) scale -= 0.1;
      allocateScene(Math.max(2, Math.round(cssWidth * scale)), Math.max(2, Math.round(cssHeight * scale)));
    };

    /* ── controls ── */
    let dragging = false, lastX = 0, lastY = 0, pointerId = null;

    const onDown = (event) => {
      dragging = true;
      pointerId = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      camera.lastInteraction = global.performance.now();
      if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId);
    };

    const onMove = (event) => {
      if (!dragging || event.pointerId !== pointerId) return;
      camera.azimuth -= (event.clientX - lastX) * 0.0085;
      camera.elevation = clamp(camera.elevation + (event.clientY - lastY) * 0.005, -0.32, 0.72);
      lastX = event.clientX;
      lastY = event.clientY;
      camera.lastInteraction = global.performance.now();
    };

    const onUp = (event) => {
      if (event.pointerId !== pointerId) return;
      dragging = false;
      pointerId = null;
      camera.lastInteraction = global.performance.now();
    };

    const onWheel = (event) => {
      event.preventDefault();
      camera.radius = clamp(camera.radius * (1 + event.deltaY * 0.0011), 1.55, 3.60);
      camera.lastInteraction = global.performance.now();
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    let observer = null;
    if (global.ResizeObserver) {
      observer = new global.ResizeObserver(() => resize());
      observer.observe(canvas);
    }

    let visible = true;
    let intersection = null;
    if (global.IntersectionObserver) {
      intersection = new global.IntersectionObserver((entries) => { visible = entries[0].isIntersecting; });
      intersection.observe(canvas);
    }

    /* ── the frame ── */
    let frame = 0;
    let running = true;
    const start = global.performance.now();

    const draw = (now) => {
      if (!running) return;
      frame = global.requestAnimationFrame(draw);
      if (!visible) return;
      if (renderWidth === 0) resize();

      const time = (now - start) / 1000;

      if (state.morphStart >= 0) {
        state.morph = clamp((now - state.morphStart) / MORPH_MS, 0, 1);
        if (state.morph >= 1) state.morphStart = -1;
      }

      if (camera.spin && now - camera.lastInteraction > 3500 && !dragging) {
        camera.azimuth += 0.0021;
      }

      // In a tall, narrow frame the horizontal field of view closes in, so the
      // camera steps back to keep the sleeves and the collar inside the shot.
      const aspect = cssWidth / cssHeight;
      const distance = camera.radius * (aspect < 1 ? Math.pow(1 / aspect, 0.55) : 1);
      const eye = [
        Math.sin(camera.azimuth) * Math.cos(camera.elevation) * distance,
        camera.targetY + Math.sin(camera.elevation) * distance,
        Math.cos(camera.azimuth) * Math.cos(camera.elevation) * distance,
      ];
      const view = m4.lookAt(eye, [0, camera.targetY, 0], [0, 1, 0]);
      const proj = m4.perspective(0.56, aspect, 0.05, 20);
      const model = m4.identity();
      const life = reduceMotion ? 0 : 1;
      const morph = easedMorph();

      /* 1 — cast the shadow onto the backdrop */
      gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFBO);
      gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(shadow.program);
      gl.uniformMatrix4fv(shadow.uniforms.uModel, false, model);
      gl.uniformMatrix4fv(shadow.uniforms.uShadowProj, false, shadowProj);
      gl.uniform3f(shadow.uniforms.uLight, -0.62, 0.80, 0.68);
      gl.uniform1f(shadow.uniforms.uMorph, morph);
      gl.uniform1f(shadow.uniforms.uTime, time);
      gl.uniform1f(shadow.uniforms.uLife, life);
      gl.uniform1f(shadow.uniforms.uGroundY, GROUND_Y);
      gl.bindVertexArray(garmentVAO);
      gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_INT, 0);

      /* 2 — the scene */
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFBO);
      gl.viewport(0, 0, renderWidth, renderHeight);
      gl.clearColor(state.backdrop[0] * 0.68, state.backdrop[1] * 0.68, state.backdrop[2] * 0.68, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.CULL_FACE);

      gl.useProgram(ground.program);
      gl.uniformMatrix4fv(ground.uniforms.uProj, false, proj);
      gl.uniformMatrix4fv(ground.uniforms.uView, false, view);
      gl.uniform1f(ground.uniforms.uGroundY, GROUND_Y);
      gl.uniform1f(ground.uniforms.uExtent, EXTENT);
      gl.uniform3fv(ground.uniforms.uBackdrop, state.backdrop);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, shadowTex);
      gl.uniform1i(ground.uniforms.uShadow, 0);
      gl.bindVertexArray(quadVAO);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      gl.useProgram(garment.program);
      gl.uniformMatrix4fv(garment.uniforms.uProj, false, proj);
      gl.uniformMatrix4fv(garment.uniforms.uView, false, view);
      gl.uniformMatrix4fv(garment.uniforms.uModel, false, model);
      gl.uniform3fv(garment.uniforms.uCamera, new Float32Array(eye));
      gl.uniform3fv(garment.uniforms.uCloth, state.cloth);
      gl.uniform3fv(garment.uniforms.uButton, state.button);
      gl.uniform3fv(garment.uniforms.uThread, state.thread);
      gl.uniform1f(garment.uniforms.uWeaveScale, state.weaveScale);
      gl.uniform1f(garment.uniforms.uWeaveDepth, state.weaveDepth);
      gl.uniform1f(garment.uniforms.uPlacketMode, state.placketMode);
      gl.uniform1f(garment.uniforms.uButtonGloss, state.buttonGloss);
      gl.uniform1f(garment.uniforms.uMorph, morph);
      gl.uniform1f(garment.uniforms.uTime, time);
      gl.uniform1f(garment.uniforms.uLife, life);
      gl.uniform1f(garment.uniforms.uDecalPart, state.decalPart);
      gl.uniform4fv(garment.uniforms.uDecalRect, new Float32Array(state.decalRect));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, decalTex);
      gl.uniform1i(garment.uniforms.uDecal, 0);
      gl.bindVertexArray(garmentVAO);
      gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_INT, 0);

      /* 3 — resolve, tone map, bloom, grain */
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(post.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sceneTex);
      gl.uniform1i(post.uniforms.uScene, 0);
      gl.uniform2f(post.uniforms.uTexel, 1 / renderWidth, 1 / renderHeight);
      gl.uniform1f(post.uniforms.uTime, time);
      gl.uniform1f(post.uniforms.uBloom, hdr ? 0.55 : 0.22);
      gl.bindVertexArray(quadVAO);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindVertexArray(null);
    };

    const onContextLost = (event) => { event.preventDefault(); running = false; };
    canvas.addEventListener('webglcontextlost', onContextLost);

    resize();
    update(opts.spec || {});
    frame = global.requestAnimationFrame(draw);

    return {
      supported: true,
      update,
      resize,
      setBackdrop(hex) { state.backdrop = hexToLinear(hex, '#EDEAE3'); },
      setSpin(on) { camera.spin = Boolean(on) && !reduceMotion; },
      resetView() { camera.azimuth = 0.42; camera.elevation = 0.21; camera.radius = 2.92; camera.lastInteraction = global.performance.now(); },
      destroy() {
        running = false;
        global.cancelAnimationFrame(frame);
        if (observer) observer.disconnect();
        if (intersection) intersection.disconnect();
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onUp);
        canvas.removeEventListener('wheel', onWheel);
        canvas.removeEventListener('webglcontextlost', onContextLost);
      },
    };
  };

  global.createGarmentView = createGarmentView;
})(typeof window !== 'undefined' ? window : globalThis);
