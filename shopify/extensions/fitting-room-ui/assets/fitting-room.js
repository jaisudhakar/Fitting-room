/**
 * Fitting room — storefront behaviour.
 *
 * The theme holds no catalogue and no prices: it renders whatever the app proxy
 * returns, and every quote comes back from the server with the signed cart line
 * properties already attached. Adding to the cart is then just handing those
 * properties to Shopify.
 */
(() => {
  "use strict";

  const root = document.querySelector("[data-fitting-room]");
  if (!root) return;

  const proxy = root.dataset.proxy || "/apps/fitting-room";
  const handle = root.dataset.product;
  const variantId = root.dataset.variant;
  const tryOnEnabled = root.dataset.tryOn === "true";
  const redirectToCart = root.dataset.cartRedirect === "true";

  const el = {
    steps: root.querySelector("[data-fr-steps]"),
    summary: root.querySelector("[data-fr-summary]"),
    total: root.querySelector("[data-fr-total]"),
    lead: root.querySelector("[data-fr-lead]"),
    issues: root.querySelector("[data-fr-issues]"),
    add: root.querySelector("[data-fr-add]"),
    tryOn: root.querySelector("[data-fr-tryon]"),
    stage: root.querySelector("[data-fr-stage]"),
    picks: root.querySelector("[data-fr-picks]"),
    hang: root.querySelector("[data-fr-hang]"),
    draw: root.querySelector("[data-fr-draw]"),
    reset: root.querySelector("[data-fr-reset]"),
    tryOnError: root.querySelector("[data-fr-tryon-error]"),
  };

  const state = { config: null, options: {}, measurements: {}, monogram: null, line: null, tryOn: null };

  const api = async (path, { method = "GET", body } = {}) => {
    const response = await fetch(`${proxy}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message || `The fitting room answered ${response.status}.`);
    return payload;
  };

  /* ── rendering the options ─────────────────────────────────────── */
  const chip = (group, value) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "fitting-room__chip";
    button.dataset.group = group.id;
    button.dataset.value = value.id;
    button.setAttribute("aria-pressed", String(state.options[group.id] === value.id));

    if (value.swatch) {
      const dot = document.createElement("span");
      dot.className = "fitting-room__swatch";
      dot.style.background = value.swatch;
      button.append(dot);
    }

    const label = document.createElement("span");
    label.textContent = value.label;
    button.append(label);

    if (value.formattedPriceDelta) {
      const delta = document.createElement("span");
      delta.className = "fitting-room__delta";
      delta.textContent = value.formattedPriceDelta;
      button.append(delta);
    }

    button.addEventListener("click", () => {
      state.options[group.id] = value.id;
      paintSelection();
      quote();
    });

    return button;
  };

  const measurementFields = () => {
    const wrap = document.createElement("div");
    wrap.className = "fitting-room__group";
    wrap.dataset.measurements = "true";
    wrap.innerHTML = '<span class="fitting-room__label">Your measurements</span>';

    const fields = document.createElement("div");
    fields.className = "fitting-room__fields";
    for (const field of state.config.madeToMeasure.fields) {
      const item = document.createElement("label");
      item.className = "fitting-room__field";
      item.innerHTML = `<span>${field.label} (${field.min}–${field.max} ${field.unit})</span>`;
      const input = document.createElement("input");
      input.type = "number";
      input.min = String(field.min);
      input.max = String(field.max);
      input.step = "0.5";
      input.value = state.measurements[field.id] ?? "";
      input.addEventListener("input", () => {
        if (input.value === "") delete state.measurements[field.id];
        else state.measurements[field.id] = Number(input.value);
        quote();
      });
      item.append(input);
      fields.append(item);
    }
    wrap.append(fields);
    return wrap;
  };

  const monogramFields = () => {
    const wrap = document.createElement("div");
    wrap.className = "fitting-room__group";
    wrap.innerHTML = '<span class="fitting-room__label">Monogram</span>';

    const toggle = document.createElement("label");
    toggle.className = "fitting-room__field";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = Boolean(state.monogram);
    toggle.append(check, document.createTextNode(` Embroider initials (${state.config.monogram.formattedFee})`));
    wrap.append(toggle);

    const fields = document.createElement("div");
    fields.className = "fitting-room__fields";
    fields.hidden = !state.monogram;

    const text = document.createElement("input");
    text.type = "text";
    text.maxLength = state.config.monogram.maxLength;
    text.placeholder = "JD";
    text.value = state.monogram?.text ?? "";
    text.addEventListener("input", () => {
      if (!state.monogram) return;
      state.monogram.text = text.value.toUpperCase().trim();
      quote();
    });

    const position = document.createElement("select");
    position.innerHTML = state.config.monogram.positions
      .map((item) => `<option value="${item.id}">${item.label}</option>`)
      .join("");
    position.addEventListener("change", () => {
      if (!state.monogram) return;
      state.monogram.position = position.value;
      quote();
    });

    const thread = document.createElement("select");
    thread.innerHTML = state.config.monogram.threads.map((item) => `<option value="${item.id}">${item.label}</option>`).join("");
    thread.addEventListener("change", () => {
      if (!state.monogram) return;
      state.monogram.thread = thread.value;
      quote();
    });

    check.addEventListener("change", () => {
      state.monogram = check.checked
        ? {
            text: text.value.toUpperCase().trim(),
            position: position.value,
            font: state.config.monogram.fonts[0].id,
            thread: thread.value,
          }
        : null;
      fields.hidden = !state.monogram;
      quote();
    });

    fields.append(text, position, thread);
    wrap.append(fields);
    return wrap;
  };

  const renderSteps = () => {
    el.steps.innerHTML = "";
    for (const group of state.config.groups) {
      const wrap = document.createElement("div");
      wrap.className = "fitting-room__group";
      wrap.dataset.group = group.id;
      wrap.innerHTML = `<span class="fitting-room__label">${group.label}</span>`;

      const chips = document.createElement("div");
      chips.className = "fitting-room__chips";
      for (const value of group.values) chips.append(chip(group, value));
      wrap.append(chips);
      el.steps.append(wrap);

      if (group.id === "size") {
        const slot = document.createElement("div");
        slot.dataset.measurementSlot = "true"; // renders as data-measurement-slot
        el.steps.append(slot);
      }
    }
    if (state.config.monogram.enabled) el.steps.append(monogramFields());
    paintSelection();
  };

  const paintSelection = () => {
    root.querySelectorAll(".fitting-room__chip").forEach((button) => {
      button.setAttribute("aria-pressed", String(state.options[button.dataset.group] === button.dataset.value));
    });

    const slot = root.querySelector("[data-measurement-slot]");
    const needsMeasurements = state.options.size === "made-to-measure" && state.config.madeToMeasure.enabled;
    if (slot) {
      if (needsMeasurements && !slot.firstChild) slot.append(measurementFields());
      if (!needsMeasurements) slot.innerHTML = "";
    }
  };

  /* ── the price, and the properties that carry it ───────────────── */
  let quoteTimer;
  const quote = () => {
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(async () => {
      try {
        const result = await api(`/quote?product=${encodeURIComponent(handle)}`, {
          method: "POST",
          body: {
            product: handle,
            selection: { options: state.options, measurements: state.measurements, monogram: state.monogram, quantity: 1 },
          },
        });

        state.line = result.line;
        el.summary.hidden = false;
        el.total.textContent = result.price.formatted.total;
        el.lead.textContent = `ships in ${result.price.leadTimeDays} days`;

        const issues = result.validation.issues;
        el.issues.hidden = issues.length === 0;
        el.issues.innerHTML = issues.map((issue) => `<li>${issue.message}</li>`).join("");
        root.querySelectorAll(".fitting-room__chip").forEach((button) => {
          const flagged = issues.some(
            (issue) => issue.field === `options.${button.dataset.group}` && button.getAttribute("aria-pressed") === "true",
          );
          button.dataset.flagged = String(flagged);
        });

        el.add.disabled = !result.valid;
        if (el.hang) el.hang.disabled = !result.valid;
      } catch (error) {
        el.issues.hidden = false;
        el.issues.innerHTML = `<li>${error.message}</li>`;
        el.add.disabled = true;
      }
    }, 250);
  };

  el.add.addEventListener("click", async () => {
    if (!state.line) return;
    el.add.disabled = true;
    try {
      const response = await fetch("/cart/add.js", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [{ id: Number(state.line.variantId ?? variantId), quantity: state.line.quantity, properties: state.line.properties }],
        }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.description || "The cart refused that line.");

      document.dispatchEvent(new CustomEvent("fitting-room:added", { detail: state.line }));
      if (redirectToCart) window.location.href = "/cart";
      else el.add.textContent = "Added";
    } catch (error) {
      el.issues.hidden = false;
      el.issues.innerHTML = `<li>${error.message}</li>`;
    } finally {
      el.add.disabled = false;
      setTimeout(() => (el.add.textContent = root.querySelector("[data-fr-add]").dataset.label || "Add to basket"), 2000);
    }
  });

  /* ── the try-on ────────────────────────────────────────────────── */
  const renderTryOn = (payload) => {
    state.tryOn = payload;
    el.picks.innerHTML = payload.picks
      .map((pick) => `<button class="fitting-room__pick" style="background:${pick.swatch}" data-pick="${pick.id}" title="Take off ${pick.details.fabric}"></button>`)
      .join("");
    el.picks.querySelectorAll("[data-pick]").forEach((button) => {
      button.addEventListener("click", async () => {
        renderTryOn(await api(`/try-on/sessions/${payload.session.id}/picks/${button.dataset.pick}`, { method: "DELETE" }));
      });
    });
    el.draw.disabled = payload.pieces === 0;
  };

  const tryOnError = (message) => {
    el.tryOnError.hidden = !message;
    el.tryOnError.textContent = message || "";
  };

  const startTryOn = async () => {
    el.tryOn.hidden = false;
    renderTryOn(await api("/try-on/sessions", { method: "POST" }));
  };

  if (tryOnEnabled && el.tryOn) {
    el.hang.addEventListener("click", async () => {
      tryOnError("");
      try {
        if (!state.tryOn) await startTryOn();
        renderTryOn(
          await api(`/try-on/sessions/${state.tryOn.session.id}/picks`, {
            method: "POST",
            body: {
              product: handle,
              selection: { options: state.options, measurements: state.measurements, monogram: state.monogram },
            },
          }),
        );
      } catch (error) {
        tryOnError(error.message);
      }
    });

    el.draw.addEventListener("click", async () => {
      tryOnError("");
      el.draw.disabled = true;
      el.draw.textContent = "Drawing the look…";
      try {
        const look = await api(`/try-on/sessions/${state.tryOn.session.id}/looks`, { method: "POST", body: {} });
        el.stage.innerHTML = `<img src="${proxy}/try-on/looks/${look.id}/image" alt="The look drawn on the atelier form">`;
      } catch (error) {
        tryOnError(error.message);
      } finally {
        el.draw.disabled = false;
        el.draw.textContent = "Draw the look";
      }
    });

    el.reset.addEventListener("click", async () => {
      tryOnError("");
      if (!state.tryOn) return;
      el.stage.innerHTML = "";
      renderTryOn(await api(`/try-on/sessions/${state.tryOn.session.id}/reset`, { method: "POST" }));
    });
  }

  /* ── open ──────────────────────────────────────────────────────── */
  (async () => {
    try {
      state.config = await api(`/config?product=${encodeURIComponent(handle)}`);
      state.options = { ...state.config.defaultSelection.options };
      el.add.dataset.label = el.add.textContent.trim();
      renderSteps();
      quote();
      if (tryOnEnabled && el.tryOn) await startTryOn();
    } catch (error) {
      el.steps.innerHTML = `<p class="fitting-room__error">${error.message}</p>`;
    }
  })();
})();
