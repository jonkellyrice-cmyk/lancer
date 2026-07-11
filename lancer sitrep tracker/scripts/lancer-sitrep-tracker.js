const MODULE_ID = "lancer-sitrep-tracker";
const FLAG_KEY = "sitrep";
const HUD_ID = "lancer-sitrep-hud";
const HUD_STATE_KEY = `${MODULE_ID}.hudState`;

const DEFAULTS = {
  type: "gauntlet",
  title: "GAUNTLET",
  objective:
    "Have more allied units than hostile units in the control zone at the end of the final round.",
  regionId: "",
  startRound: 1,
  roundLimit: 8,
  finalRound: 8,
  active: true,
  status: "active",
  resultReason: "",
  rules: {
    finalZoneControl: true,
    enemyElimination: true,
    unassailableControl: true
  }
};

const SITREP_TYPES = [
  { value: "control", label: "Control" },
  { value: "escort", label: "Escort" },
  { value: "extraction", label: "Extraction" },
  { value: "gauntlet", label: "Gauntlet" },
  { value: "holdout", label: "Holdout" },
  { value: "recon", label: "Recon" }
];

const esc = value =>
  foundry.utils.escapeHTML(String(value ?? ""));

/* ==========================================================
   Core Sitrep helpers
   ========================================================== */

function activeCombat() {
  return game.combat ?? game.combats?.active ?? null;
}

function getSitrep(combat = activeCombat()) {
  return combat?.getFlag(MODULE_ID, FLAG_KEY) ?? null;
}

function isPrimaryGM() {
  if (!game.user?.isGM) return false;

  const activeGMs = game.users.filter(
    user => user.active && user.isGM
  );

  return !activeGMs.length || activeGMs[0].id === game.user.id;
}

function tokenDisposition(tokenDocument) {
  return Number(tokenDocument?.disposition ?? 0);
}

function factionOf(tokenDocument) {
  const disposition = tokenDisposition(tokenDocument);

  const friendly = Number(
    CONST.TOKEN_DISPOSITIONS?.FRIENDLY ?? 1
  );

  const hostile = Number(
    CONST.TOKEN_DISPOSITIONS?.HOSTILE ?? -1
  );

  if (disposition === friendly) return "friendly";
  if (disposition === hostile) return "hostile";

  return "neutral";
}

function combatantIsDefeated(combatant) {
  if (typeof combatant?.isDefeated === "boolean") {
    return combatant.isDefeated;
  }

  if (combatant?.defeated === true) {
    return true;
  }

  const defeatedId = CONFIG.specialStatusEffects?.DEFEATED;

  return Boolean(
    defeatedId &&
    combatant?.actor?.statuses?.has?.(defeatedId)
  );
}

function regionFor(combat, sitrep) {
  const scene = combat?.scene ?? canvas.scene;

  return scene?.regions?.get(sitrep?.regionId) ?? null;
}

function tokenInsideRegion(tokenDocument, region) {
  if (!tokenDocument || !region) return false;

  try {
    return Boolean(tokenDocument.testInsideRegion(region));
  } catch (error) {
    console.warn(
      `${MODULE_ID} | Could not test token in Region`,
      error
    );

    return Boolean(
      tokenDocument.regions?.has?.(region.id)
    );
  }
}

function calculateState(
  combat = activeCombat(),
  sitrep = getSitrep(combat)
) {
  const empty = {
    valid: false,
    currentRound: Number(combat?.round ?? 0),
    roundsRemaining: 0,
    friendlyStanding: 0,
    hostileStanding: 0,
    friendlyInZone: 0,
    hostileInZone: 0,
    controller: "none",
    regionName: "Missing Region",
    immediateVictory: false,
    immediateReason: ""
  };

  if (!combat || !sitrep) return empty;

  const region = regionFor(combat, sitrep);

  if (!region) return empty;

  const state = {
    ...empty,
    valid: true,
    regionName: region.name || "Control Zone"
  };

  for (const combatant of combat.combatants ?? []) {
    if (combatantIsDefeated(combatant)) continue;

    const token = combatant.token;

    if (!token) continue;

    const faction = factionOf(token);

    if (faction === "neutral") continue;

    const inside = tokenInsideRegion(token, region);

    if (faction === "friendly") {
      state.friendlyStanding += 1;

      if (inside) {
        state.friendlyInZone += 1;
      }
    } else {
      state.hostileStanding += 1;

      if (inside) {
        state.hostileInZone += 1;
      }
    }
  }

  if (state.friendlyInZone > state.hostileInZone) {
    state.controller = "friendly";
  } else if (
    state.hostileInZone > state.friendlyInZone
  ) {
    state.controller = "hostile";
  } else {
    state.controller = "contested";
  }

  const currentRound = Math.max(
    Number(combat.round ?? sitrep.startRound ?? 1),
    1
  );

  state.currentRound = currentRound;

  state.roundsRemaining = Math.max(
    Number(sitrep.finalRound) - currentRound + 1,
    0
  );

  if (
    sitrep.rules?.enemyElimination &&
    state.hostileStanding === 0 &&
    state.friendlyStanding > 0
  ) {
    state.immediateVictory = true;
    state.immediateReason =
      "All hostile units have been defeated.";
  } else if (
    sitrep.rules?.unassailableControl &&
    state.friendlyInZone > 0 &&
    state.friendlyInZone > state.hostileStanding
  ) {
    state.immediateVictory = true;
    state.immediateReason =
      "The allies already in the zone outnumber every surviving hostile unit.";
  }

  return state;
}

function progressPips(sitrep, state) {
  const total = Math.max(
    Number(sitrep.roundLimit ?? 8),
    1
  );

  const remaining = Math.min(
    Math.max(state.roundsRemaining, 0),
    total
  );

  return Array.from(
    { length: total },
    (_, index) =>
      `<span class="lst-pip ${
        index < remaining ? "filled" : ""
      }"></span>`
  ).join("");
}

function controlLabel(controller) {
  if (controller === "friendly") {
    return "ALLIED CONTROL";
  }

  if (controller === "hostile") {
    return "HOSTILE CONTROL";
  }

  return "CONTESTED";
}

/* ==========================================================
   Saved HUD position and minimized state
   ========================================================== */

function readHUDState() {
  try {
    const stored =
      localStorage.getItem(HUD_STATE_KEY);

    if (!stored) return {};

    const parsed = JSON.parse(stored);

    return parsed && typeof parsed === "object"
      ? parsed
      : {};
  } catch (error) {
    console.warn(
      `${MODULE_ID} | Could not read HUD state`,
      error
    );

    return {};
  }
}

function writeHUDState(changes = {}) {
  const state = {
    ...readHUDState(),
    ...changes
  };

  try {
    localStorage.setItem(
      HUD_STATE_KEY,
      JSON.stringify(state)
    );
  } catch (error) {
    console.warn(
      `${MODULE_ID} | Could not save HUD state`,
      error
    );
  }

  return state;
}

function getSidebarRectangle() {
  const sidebar =
    document.querySelector("#sidebar") ??
    document.querySelector("#ui-right");

  return sidebar?.getBoundingClientRect?.() ?? null;
}

function clampHUDPosition(hud, left, top) {
  const margin = 8;

  const maximumLeft = Math.max(
    margin,
    window.innerWidth - hud.offsetWidth - margin
  );

  const maximumTop = Math.max(
    margin,
    window.innerHeight - hud.offsetHeight - margin
  );

  return {
    left: Math.min(
      Math.max(Number(left) || margin, margin),
      maximumLeft
    ),
    top: Math.min(
      Math.max(Number(top) || margin, margin),
      maximumTop
    )
  };
}

function defaultHUDPosition(hud) {
  const sidebarRect = getSidebarRectangle();

  /*
   * Leave a visible gap between the HUD and the sidebar.
   * Foundry's sidebar is normally on the right side.
   */
  const sidebarLeft =
    sidebarRect?.left ??
    window.innerWidth - 320;

  const desiredLeft =
    sidebarLeft - hud.offsetWidth - 24;

  return clampHUDPosition(
    hud,
    desiredLeft,
    80
  );
}

function applyHUDPosition(hud) {
  const savedState = readHUDState();

  const hasSavedLeft =
    Number.isFinite(Number(savedState.left));

  const hasSavedTop =
    Number.isFinite(Number(savedState.top));

  const position =
    hasSavedLeft && hasSavedTop
      ? clampHUDPosition(
          hud,
          Number(savedState.left),
          Number(savedState.top)
        )
      : defaultHUDPosition(hud);

  hud.style.left = `${position.left}px`;
  hud.style.top = `${position.top}px`;
  hud.style.right = "auto";

  if (!hasSavedLeft || !hasSavedTop) {
    writeHUDState(position);
  }
}

function updateMinimizeButton(hud, minimized) {
  const button = hud.querySelector(
    '[data-action="minimize"]'
  );

  const icon = button?.querySelector("i");

  if (!button) return;

  button.title = minimized
    ? "Restore Sitrep"
    : "Minimize Sitrep";

  button.setAttribute(
    "aria-label",
    minimized
      ? "Restore Sitrep"
      : "Minimize Sitrep"
  );

  if (icon) {
    icon.className = minimized
      ? "fas fa-window-maximize"
      : "fas fa-window-minimize";
  }
}

function applyHUDMinimizedState(hud) {
  const minimized =
    readHUDState().minimized === true;

  hud.classList.toggle(
    "lst-minimized",
    minimized
  );

  updateMinimizeButton(hud, minimized);
}

function toggleHUDMinimized(hud) {
  const minimized =
    !hud.classList.contains("lst-minimized");

  hud.classList.toggle(
    "lst-minimized",
    minimized
  );

  updateMinimizeButton(hud, minimized);

  writeHUDState({ minimized });

  /*
   * Changing the HUD size can push part of it offscreen.
   */
  requestAnimationFrame(() => {
    const rectangle =
      hud.getBoundingClientRect();

    const position = clampHUDPosition(
      hud,
      rectangle.left,
      rectangle.top
    );

    hud.style.left = `${position.left}px`;
    hud.style.top = `${position.top}px`;

    writeHUDState(position);
  });
}

function makeHUDDraggable(hud) {
  const handle = hud.querySelector(".lst-header");

  if (!handle) return;

  handle.addEventListener(
    "pointerdown",
    event => {
      if (event.button !== 0) return;

      /*
       * Clicking a header button should not begin dragging.
       */
      if (event.target.closest("button")) {
        return;
      }

      event.preventDefault();

      const startingRectangle =
        hud.getBoundingClientRect();

      const startingPointerX = event.clientX;
      const startingPointerY = event.clientY;

      hud.classList.add("lst-dragging");

      handle.setPointerCapture?.(
        event.pointerId
      );

      const handlePointerMove = moveEvent => {
        const desiredLeft =
          startingRectangle.left +
          moveEvent.clientX -
          startingPointerX;

        const desiredTop =
          startingRectangle.top +
          moveEvent.clientY -
          startingPointerY;

        const position = clampHUDPosition(
          hud,
          desiredLeft,
          desiredTop
        );

        hud.style.left = `${position.left}px`;
        hud.style.top = `${position.top}px`;
        hud.style.right = "auto";
      };

      const stopDragging = endEvent => {
        hud.classList.remove("lst-dragging");

        handle.removeEventListener(
          "pointermove",
          handlePointerMove
        );

        handle.removeEventListener(
          "pointerup",
          stopDragging
        );

        handle.removeEventListener(
          "pointercancel",
          stopDragging
        );

        try {
          handle.releasePointerCapture?.(
            endEvent.pointerId
          );
        } catch {
          // Pointer capture may already have been released.
        }

        const finalRectangle =
          hud.getBoundingClientRect();

        writeHUDState({
          left: Math.round(finalRectangle.left),
          top: Math.round(finalRectangle.top)
        });
      };

      handle.addEventListener(
        "pointermove",
        handlePointerMove
      );

      handle.addEventListener(
        "pointerup",
        stopDragging
      );

      handle.addEventListener(
        "pointercancel",
        stopDragging
      );
    }
  );
}

function keepHUDOnScreen() {
  const hud =
    document.getElementById(HUD_ID);

  if (!hud) return;

  const rectangle =
    hud.getBoundingClientRect();

  const position = clampHUDPosition(
    hud,
    rectangle.left,
    rectangle.top
  );

  hud.style.left = `${position.left}px`;
  hud.style.top = `${position.top}px`;
  hud.style.right = "auto";

  writeHUDState(position);
}

/* ==========================================================
   HUD rendering
   ========================================================== */

function renderHUD() {
  document.getElementById(HUD_ID)?.remove();

  const combat = activeCombat();
  const sitrep = getSitrep(combat);

  if (!combat || !sitrep?.active) return;

  const state = calculateState(combat, sitrep);

  const hud = document.createElement("section");

  hud.id = HUD_ID;

  hud.className = [
    "lst-hud",
    `lst-${esc(sitrep.status)}`,
    `lst-control-${esc(state.controller)}`
  ].join(" ");

  let statusText =
    state.roundsRemaining === 1
      ? "FINAL ROUND"
      : `${state.roundsRemaining} ROUNDS REMAINING`;

  if (sitrep.status === "victory") {
    statusText = "MISSION SUCCESS";
  }

  if (sitrep.status === "defeat") {
    statusText = "MISSION FAILED";
  }

  if (sitrep.status === "paused") {
    statusText = "SITREP PAUSED";
  }

  hud.innerHTML = `
    <header class="lst-header">
      <div class="lst-header-title">
        <div class="lst-kicker">LANCER SITREP</div>
        <h2>${esc(sitrep.title)}</h2>
      </div>

      <div class="lst-header-actions">
        <button
          type="button"
          data-action="minimize"
          title="Minimize Sitrep"
          aria-label="Minimize Sitrep"
        >
          <i class="fas fa-window-minimize"></i>
        </button>

        ${
          game.user.isGM
            ? `
              <button
                type="button"
                data-action="configure"
                title="Configure Sitrep"
                aria-label="Configure Sitrep"
              >
                <i class="fas fa-cog"></i>
              </button>
            `
            : ""
        }
      </div>
    </header>

    <div class="lst-hud-body">
      <div class="lst-objective">
        ${esc(sitrep.objective)}
      </div>

      <div class="lst-clock">
        <div class="lst-clock-row">
          <strong>${esc(statusText)}</strong>

          <span>
            ROUND ${state.currentRound} /
            ${sitrep.finalRound}
          </span>
        </div>

        <div class="lst-pips">
          ${progressPips(sitrep, state)}
        </div>
      </div>

      ${
        state.valid
          ? `
            <div class="lst-zone-name">
              <i class="fas fa-bullseye"></i>
              ${esc(state.regionName)}
            </div>

            <div class="lst-control-banner">
              ${controlLabel(state.controller)}
            </div>

            <div class="lst-grid">
              <div class="lst-stat allied">
                <span>ALLIES IN ZONE</span>
                <strong>${state.friendlyInZone}</strong>
              </div>

              <div class="lst-stat hostile">
                <span>HOSTILES IN ZONE</span>
                <strong>${state.hostileInZone}</strong>
              </div>

              <div class="lst-stat allied">
                <span>ALLIES STANDING</span>
                <strong>${state.friendlyStanding}</strong>
              </div>

              <div class="lst-stat hostile">
                <span>HOSTILES STANDING</span>
                <strong>${state.hostileStanding}</strong>
              </div>
            </div>
          `
          : `
            <div class="lst-error">
              The configured Region cannot be found on
              this combat's Scene.
            </div>
          `
      }

      ${
        sitrep.resultReason
          ? `
            <div class="lst-result-reason">
              ${esc(sitrep.resultReason)}
            </div>
          `
          : ""
      }

      ${
        game.user.isGM
          ? `
            <footer class="lst-controls">
              <button
                type="button"
                data-action="toggle"
              >
                ${
                  sitrep.status === "paused"
                    ? "Resume"
                    : "Pause"
                }
              </button>

              <button
                type="button"
                data-action="victory"
              >
                Victory
              </button>

              <button
                type="button"
                data-action="defeat"
              >
                Defeat
              </button>

              <button
                type="button"
                data-action="end"
              >
                Close
              </button>
            </footer>
          `
          : ""
      }
    </div>
  `;

  document.body.appendChild(hud);

  applyHUDPosition(hud);
  applyHUDMinimizedState(hud);
  makeHUDDraggable(hud);

  hud
    .querySelector('[data-action="minimize"]')
    ?.addEventListener("click", () => {
      toggleHUDMinimized(hud);
    });

  hud
    .querySelector('[data-action="configure"]')
    ?.addEventListener(
      "click",
      openSetupDialog
    );

  hud
    .querySelector('[data-action="toggle"]')
    ?.addEventListener(
      "click",
      togglePause
    );

  hud
    .querySelector('[data-action="victory"]')
    ?.addEventListener(
      "click",
      () =>
        setResult(
          "victory",
          "Victory declared by the GM."
        )
    );

  hud
    .querySelector('[data-action="defeat"]')
    ?.addEventListener(
      "click",
      () =>
        setResult(
          "defeat",
          "Defeat declared by the GM."
        )
    );

  hud
    .querySelector('[data-action="end"]')
    ?.addEventListener(
      "click",
      endSitrep
    );
}

/* ==========================================================
   Victory and encounter state
   ========================================================== */

async function setResult(status, reason) {
  const combat = activeCombat();
  const sitrep = getSitrep(combat);

  if (
    !game.user.isGM ||
    !combat ||
    !sitrep
  ) {
    return;
  }

  await combat.setFlag(
    MODULE_ID,
    FLAG_KEY,
    {
      ...sitrep,
      status,
      resultReason: reason
    }
  );

  if (isPrimaryGM()) {
    await ChatMessage.create({
      speaker: {
        alias: "MISSION CONTROL"
      },

      content: `
        <div class="lst-chat-result ${status}">
          <strong>
            ${
              status === "victory"
                ? "MISSION SUCCESS"
                : "MISSION FAILED"
            }
          </strong>

          <br>

          ${esc(reason)}
        </div>
      `
    });
  }
}

async function evaluateSitrep(
  combat,
  changes = {}
) {
  const sitrep = getSitrep(combat);

  if (
    !sitrep?.active ||
    sitrep.status !== "active" ||
    !isPrimaryGM()
  ) {
    return;
  }

  const state = calculateState(
    combat,
    sitrep
  );

  if (!state.valid) return;

  if (state.immediateVictory) {
    await setResult(
      "victory",
      state.immediateReason
    );

    return;
  }

  const roundChanged =
    Object.prototype.hasOwnProperty.call(
      changes,
      "round"
    );

  const previousRound = Number(
    combat.previous?.round ?? 0
  );

  const advancedPastFinalRound =
    roundChanged &&
    Number(combat.round) >
      Number(sitrep.finalRound);

  const fallbackPastFinalRound =
    roundChanged &&
    previousRound ===
      Number(sitrep.finalRound) &&
    Number(combat.round) !== previousRound;

  if (
    advancedPastFinalRound ||
    fallbackPastFinalRound
  ) {
    const won =
      sitrep.rules?.finalZoneControl &&
      state.friendlyInZone >
        state.hostileInZone &&
      state.friendlyInZone > 0;

    const reason = won
      ? `At the end of round ${sitrep.finalRound}, allied units controlled the zone ${state.friendlyInZone} to ${state.hostileInZone}.`
      : `At the end of round ${sitrep.finalRound}, allied units did not control the zone (${state.friendlyInZone} allied, ${state.hostileInZone} hostile).`;

    await setResult(
      won ? "victory" : "defeat",
      reason
    );
  }
}

async function togglePause() {
  const combat = activeCombat();
  const sitrep = getSitrep(combat);

  if (
    !game.user.isGM ||
    !combat ||
    !sitrep
  ) {
    return;
  }

  const status =
    sitrep.status === "paused"
      ? "active"
      : "paused";

  await combat.setFlag(
    MODULE_ID,
    FLAG_KEY,
    {
      ...sitrep,
      status
    }
  );
}

async function endSitrep() {
  const combat = activeCombat();

  if (!game.user.isGM || !combat) {
    return;
  }

  await combat.unsetFlag(
    MODULE_ID,
    FLAG_KEY
  );

  document
    .getElementById(HUD_ID)
    ?.remove();
}

/* ==========================================================
   Setup dialog
   ========================================================== */

function setupDialogHTML(
  combat,
  existing
) {
  const scene =
    combat.scene ?? canvas.scene;

  const regions = [
    ...(scene?.regions ?? [])
  ];

  const regionOptions = regions
    .map(
      region => `
        <option
          value="${esc(region.id)}"
          ${
            existing?.regionId === region.id
              ? "selected"
              : ""
          }
        >
          ${esc(region.name || region.id)}
        </option>
      `
    )
    .join("");

  const startRound = Math.max(
    Number(combat.round ?? 1),
    1
  );

  const total = Number(
    existing?.roundLimit ?? 8
  );

  const selectedSitrepType =
    existing?.type ?? DEFAULTS.type;

  const sitrepTypeOptions = SITREP_TYPES
    .map(
      sitrepType => `
        <option
          value="${esc(sitrepType.value)}"
          ${
            selectedSitrepType === sitrepType.value
              ? "selected"
              : ""
          }
        >
          ${esc(sitrepType.label)}
        </option>
      `
    )
    .join("");

  return `
    <form class="lst-setup-form">
      <p>
        Draw a <strong>Scene Region</strong>
        over the control zone before beginning the sitrep.
      </p>

      <div class="form-group">
        <label>Sitrep type</label>

        <select name="sitrepType">
          ${sitrepTypeOptions}
        </select>

        <p class="notes">
          Sitrep-specific rules will be added in a future update.
          For now, all selections use the current Gauntlet tracking logic.
        </p>
      </div>

      <div class="form-group">
        <label>Mission title</label>

        <input
          type="text"
          name="title"
          value="${esc(
            existing?.title ?? "GAUNTLET"
          )}"
        >
      </div>

      <div class="form-group">
        <label>Objective shown to players</label>

        <textarea
          name="objective"
          rows="3"
        >${esc(
          existing?.objective ??
          DEFAULTS.objective
        )}</textarea>
      </div>

      <div class="form-group">
        <label>Control Region</label>

        <select name="regionId">
          <option value="">
            — Select a Region —
          </option>

          ${regionOptions}
        </select>
      </div>

      <div class="form-group">
        <label>Round limit</label>

        <input
          type="number"
          name="roundLimit"
          value="${total}"
          min="1"
          max="99"
        >

        <p class="notes">
          The sitrep begins on the current combat
          round (${startRound}) and lasts this
          many rounds.
        </p>
      </div>

      <fieldset>
        <legend>Victory conditions</legend>

        <label class="checkbox">
          <input
            type="checkbox"
            name="finalZoneControl"
            ${
              existing?.rules
                ?.finalZoneControl !== false
                ? "checked"
                : ""
            }
          >

          Control the zone at the end of the final round
        </label>

        <label class="checkbox">
          <input
            type="checkbox"
            name="enemyElimination"
            ${
              existing?.rules
                ?.enemyElimination !== false
                ? "checked"
                : ""
            }
          >

          Win immediately when no hostile units remain standing
        </label>

        <label class="checkbox">
          <input
            type="checkbox"
            name="unassailableControl"
            ${
              existing?.rules
                ?.unassailableControl !== false
                ? "checked"
                : ""
            }
          >

          Win immediately when allies in the zone
          outnumber all surviving hostiles
        </label>
      </fieldset>

      <p class="notes">
        <strong>Classification:</strong>
        Friendly token disposition = ally;
        Hostile disposition = enemy;
        Neutral tokens are ignored.
        Mark destroyed units defeated in the Combat Tracker.
      </p>
    </form>
  `;
}

async function saveSetup(
  html,
  combat
) {
  const form =
    html.querySelector("form");

  const formData =
    new FormData(form);

  const regionId = String(
    formData.get("regionId") ?? ""
  );

  if (!regionId) {
    ui.notifications.error(
      "Select a control Region."
    );

    return false;
  }

  const roundLimit = Math.max(
    Number(
      formData.get("roundLimit") ?? 8
    ),
    1
  );

  const startRound = Math.max(
    Number(combat.round ?? 1),
    1
  );

  const data = {
    ...DEFAULTS,

    type: String(
      formData.get("sitrepType") ||
      DEFAULTS.type
    ),

    title: String(
      formData.get("title") ||
      "GAUNTLET"
    ),

    objective: String(
      formData.get("objective") ||
      DEFAULTS.objective
    ),

    regionId,
    startRound,
    roundLimit,

    finalRound:
      startRound +
      roundLimit -
      1,

    rules: {
      finalZoneControl:
        formData.has(
          "finalZoneControl"
        ),

      enemyElimination:
        formData.has(
          "enemyElimination"
        ),

      unassailableControl:
        formData.has(
          "unassailableControl"
        )
    },

    active: true,
    status: "active",
    resultReason: ""
  };

  await combat.setFlag(
    MODULE_ID,
    FLAG_KEY,
    data
  );

  ui.notifications.info(
    `${data.title} started. Final round: ${data.finalRound}.`
  );

  return true;
}

function openSetupDialog() {
  if (!game.user.isGM) {
    return ui.notifications.warn(
      "Only a GM can configure a sitrep."
    );
  }

  const combat = activeCombat();

  if (!combat) {
    return ui.notifications.warn(
      "Create and activate a Combat encounter first."
    );
  }

  const scene =
    combat.scene ?? canvas.scene;

  if (!scene?.regions?.size) {
    return ui.notifications.warn(
      "Draw at least one Scene Region on the combat Scene first."
    );
  }

  const existing =
    getSitrep(combat);

  new Dialog(
    {
      title:
        "Lancer Sitrep Tracker — Setup",

      content:
        setupDialogHTML(
          combat,
          existing
        ),

      buttons: {
        start: {
          icon:
            '<i class="fas fa-play"></i>',

          label: existing
            ? "Update Sitrep"
            : "Begin Sitrep",

          callback: async html =>
            saveSetup(
              html[0] ?? html,
              combat
            )
        },

        cancel: {
          icon:
            '<i class="fas fa-times"></i>',

          label: "Cancel"
        }
      },

      default: "start",

      render: html =>
        html
          .closest(".app")
          .addClass("lst-dialog")
    },
    {
      width: 520
    }
  ).render(true);
}

/* ==========================================================
   Combat Tracker button
   ========================================================== */

function addCombatTrackerButton(
  app,
  html
) {
  if (!game.user.isGM) return;

  const root =
    html[0] ?? html;

  if (
    root.querySelector?.(
      ".lst-open-button"
    )
  ) {
    return;
  }

  const button =
    document.createElement("button");

  button.type = "button";
  button.className =
    "lst-open-button";

  button.innerHTML =
    '<i class="fas fa-bullseye"></i> Sitrep';

  button.addEventListener(
    "click",
    openSetupDialog
  );

  const header =
    root.querySelector?.(
      ".combat-tracker-header"
    ) ??
    root.querySelector?.("header") ??
    root;

  header.prepend(button);
}

/* ==========================================================
   Refreshing and Foundry hooks
   ========================================================== */

function scheduleRefresh() {
  clearTimeout(
    globalThis.__lancerSitrepRefresh
  );

  globalThis.__lancerSitrepRefresh =
    setTimeout(
      renderHUD,
      50
    );
}

function scheduleViewportClamp() {
  clearTimeout(
    globalThis.__lancerSitrepResize
  );

  globalThis.__lancerSitrepResize =
    setTimeout(
      keepHUDOnScreen,
      100
    );
}

Hooks.once("init", () => {
  console.log(
    `${MODULE_ID} | Initializing`
  );
});

Hooks.once("ready", () => {
  game.lancerSitrep = {
    openSetup: openSetupDialog,
    renderHUD,
    calculateState,
    end: endSitrep
  };

  window.addEventListener(
    "resize",
    scheduleViewportClamp
  );

  renderHUD();
});

Hooks.on(
  "renderCombatTracker",
  addCombatTrackerButton
);

Hooks.on(
  "canvasReady",
  scheduleRefresh
);

Hooks.on(
  "updateCombat",
  async (combat, changes) => {
    scheduleRefresh();

    await evaluateSitrep(
      combat,
      changes
    );
  }
);

Hooks.on(
  "updateCombatant",
  scheduleRefresh
);

Hooks.on(
  "createCombatant",
  scheduleRefresh
);

Hooks.on(
  "deleteCombatant",
  scheduleRefresh
);

Hooks.on(
  "updateToken",
  scheduleRefresh
);

Hooks.on(
  "createToken",
  scheduleRefresh
);

Hooks.on(
  "deleteToken",
  scheduleRefresh
);

Hooks.on(
  "updateRegion",
  scheduleRefresh
);

Hooks.on(
  "deleteRegion",
  scheduleRefresh
);

Hooks.on(
  "controlToken",
  scheduleRefresh
);
