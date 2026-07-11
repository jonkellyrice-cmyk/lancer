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
  controlRegionIds: [],
  escortObjectiveCombatantId: "",
  escortExtractionRegionId: "",
  escortStatus: "active",
  extractionObjectiveCombatantId: "",
  extractionZoneRegionId: "",
  extractionStatus: "active",
  scores: {
    friendly: 0,
    hostile: 0
  },
  scoredRounds: [],
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

function controlRegionsFor(combat, sitrep) {
  const scene = combat?.scene ?? canvas.scene;
  const ids = Array.isArray(sitrep?.controlRegionIds)
    ? sitrep.controlRegionIds
    : [];

  return ids
    .map(id => scene?.regions?.get(id) ?? null)
    .filter(Boolean);
}

function controllerFromCounts(friendly, hostile) {
  if (friendly > hostile) return "friendly";
  if (hostile > friendly) return "hostile";
  return "contested";
}

function combatantById(combat, combatantId) {
  return combat?.combatants?.get(combatantId) ?? null;
}

function tokenBoundsInGridSpaces(tokenDocument) {
  const gridSize = Number(canvas?.grid?.size ?? canvas?.scene?.grid?.size ?? 100);

  const left = Number(tokenDocument?.x ?? 0) / gridSize;
  const top = Number(tokenDocument?.y ?? 0) / gridSize;
  const width = Number(tokenDocument?.width ?? 1);
  const height = Number(tokenDocument?.height ?? 1);

  return {
    left,
    top,
    right: left + width,
    bottom: top + height
  };
}

function tokensAreAdjacent(firstToken, secondToken) {
  if (!firstToken || !secondToken) return false;

  const first = tokenBoundsInGridSpaces(firstToken);
  const second = tokenBoundsInGridSpaces(secondToken);

  const horizontalGap = Math.max(
    0,
    Math.max(first.left, second.left) -
      Math.min(first.right, second.right)
  );

  const verticalGap = Math.max(
    0,
    Math.max(first.top, second.top) -
      Math.min(first.bottom, second.bottom)
  );

  return horizontalGap <= 0.05 && verticalGap <= 0.05;
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
    immediateReason: "",
    controlZones: [],
    friendlyZones: 0,
    hostileZones: 0,
    friendlyScore: Number(sitrep?.scores?.friendly ?? 0),
    hostileScore: Number(sitrep?.scores?.hostile ?? 0),
    objectiveName: "Missing Objective",
    objectiveDestroyed: false,
    objectiveExtracted:
      sitrep?.escortStatus === "extracted" ||
      sitrep?.extractionStatus === "extracted",
    objectiveInExtraction: false,
    friendlyAdjacent: 0,
    hostileAdjacent: 0,
    friendlyInExtractionZone: 0,
    canExtractObjective: false
  };

  if (!combat || !sitrep) return empty;

  const currentRound = Math.max(
    Number(combat.round ?? sitrep.startRound ?? 1),
    1
  );

  const state = {
    ...empty,
    currentRound,
    roundsRemaining: Math.max(
      Number(sitrep.finalRound) - currentRound + 1,
      0
    )
  };

  const standingCombatants = [];

  for (const combatant of combat.combatants ?? []) {
    if (combatantIsDefeated(combatant)) continue;

    const token = combatant.token;
    if (!token) continue;

    const faction = factionOf(token);
    if (faction === "neutral") continue;

    standingCombatants.push({ token, faction });

    if (faction === "friendly") {
      state.friendlyStanding += 1;
    } else {
      state.hostileStanding += 1;
    }
  }

  if (sitrep.type === "control") {
    const regions = controlRegionsFor(combat, sitrep);
    state.valid = regions.length === 4;

    state.controlZones = regions.map((region, index) => {
      let friendly = 0;
      let hostile = 0;

      for (const entry of standingCombatants) {
        if (!tokenInsideRegion(entry.token, region)) continue;

        if (entry.faction === "friendly") friendly += 1;
        if (entry.faction === "hostile") hostile += 1;
      }

      const controller = controllerFromCounts(friendly, hostile);

      if (controller === "friendly") state.friendlyZones += 1;
      if (controller === "hostile") state.hostileZones += 1;

      return {
        id: region.id,
        name: region.name || `Objective ${String.fromCharCode(65 + index)}`,
        friendly,
        hostile,
        controller
      };
    });

    state.controller = controllerFromCounts(
      state.friendlyZones,
      state.hostileZones
    );

    return state;
  }

  if (sitrep.type === "extraction") {
    const scene = combat?.scene ?? canvas.scene;

    const extractionRegion = scene?.regions?.get(
      sitrep.extractionZoneRegionId
    ) ?? null;

    const objectiveCombatant = combatantById(
      combat,
      sitrep.extractionObjectiveCombatantId
    );

    const objectiveToken = objectiveCombatant?.token ?? null;

    state.valid = Boolean(
      extractionRegion &&
      objectiveCombatant &&
      objectiveToken
    );

    if (!state.valid) return state;

    state.objectiveName =
      objectiveCombatant.name ||
      objectiveToken.name ||
      "Objective";

    state.objectiveDestroyed =
      sitrep.extractionStatus === "destroyed" ||
      combatantIsDefeated(objectiveCombatant);

    state.objectiveExtracted =
      sitrep.extractionStatus === "extracted";

    state.objectiveInExtraction =
      !state.objectiveDestroyed &&
      !state.objectiveExtracted &&
      tokenInsideRegion(
        objectiveToken,
        extractionRegion
      );

    for (const entry of standingCombatants) {
      if (entry.token.id === objectiveToken.id) continue;

      if (
        entry.faction === "friendly" &&
        tokenInsideRegion(entry.token, extractionRegion)
      ) {
        state.friendlyInExtractionZone += 1;
      }

      if (!tokensAreAdjacent(entry.token, objectiveToken)) {
        continue;
      }

      if (entry.faction === "friendly") {
        state.friendlyAdjacent += 1;
      } else if (entry.faction === "hostile") {
        state.hostileAdjacent += 1;
      }
    }

    state.canExtractObjective =
      state.objectiveInExtraction &&
      state.friendlyAdjacent > 0 &&
      state.hostileAdjacent === 0 &&
      !state.objectiveDestroyed &&
      !state.objectiveExtracted;

    return state;
  }

  if (sitrep.type === "escort") {
    const scene = combat?.scene ?? canvas.scene;
    const extractionRegion = scene?.regions?.get(
      sitrep.escortExtractionRegionId
    ) ?? null;

    const objectiveCombatant = combatantById(
      combat,
      sitrep.escortObjectiveCombatantId
    );

    const objectiveToken = objectiveCombatant?.token ?? null;

    state.valid = Boolean(extractionRegion && objectiveCombatant && objectiveToken);

    if (!state.valid) return state;

    state.objectiveName =
      objectiveCombatant.name ||
      objectiveToken.name ||
      "Objective";

    state.objectiveDestroyed =
      sitrep.escortStatus === "destroyed" ||
      combatantIsDefeated(objectiveCombatant);

    state.objectiveExtracted =
      sitrep.escortStatus === "extracted";

    state.objectiveInExtraction =
      !state.objectiveDestroyed &&
      !state.objectiveExtracted &&
      tokenInsideRegion(objectiveToken, extractionRegion);

    for (const entry of standingCombatants) {
      if (entry.token.id === objectiveToken.id) continue;
      if (!tokensAreAdjacent(entry.token, objectiveToken)) continue;

      if (entry.faction === "friendly") {
        state.friendlyAdjacent += 1;
      } else if (entry.faction === "hostile") {
        state.hostileAdjacent += 1;
      }
    }

    state.canExtractObjective =
      state.objectiveInExtraction &&
      state.friendlyAdjacent > 0 &&
      state.hostileAdjacent === 0 &&
      !state.objectiveDestroyed &&
      !state.objectiveExtracted;

    return state;
  }

  const region = regionFor(combat, sitrep);
  if (!region) return state;

  state.valid = true;
  state.regionName = region.name || "Control Zone";

  for (const entry of standingCombatants) {
    if (!tokenInsideRegion(entry.token, region)) continue;

    if (entry.faction === "friendly") {
      state.friendlyInZone += 1;
    } else {
      state.hostileInZone += 1;
    }
  }

  state.controller = controllerFromCounts(
    state.friendlyInZone,
    state.hostileInZone
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

function controlZoneLabel(controller) {
  if (controller === "friendly") return "ALLIED";
  if (controller === "hostile") return "HOSTILE";
  return "CONTESTED";
}

function renderExtractionState(sitrep, state) {
  let objectiveStatus = "AWAITING RECOVERY";
  let statusClass = "active";

  if (state.objectiveExtracted) {
    objectiveStatus = "OBJECTIVE EXTRACTED";
    statusClass = "extracted";
  } else if (state.objectiveDestroyed) {
    objectiveStatus = "OBJECTIVE DESTROYED";
    statusClass = "destroyed";
  } else if (state.canExtractObjective) {
    objectiveStatus = "READY TO EXTRACT";
    statusClass = "ready";
  } else if (state.objectiveInExtraction) {
    objectiveStatus = "EXTRACTION CONTESTED";
    statusClass = "contested";
  } else if (state.friendlyAdjacent > 0) {
    objectiveStatus = "OBJECTIVE SECURED";
    statusClass = "secured";
  }

  return `
    <div class="lst-extraction-objective">
      <span>OBJECTIVE</span>
      <strong>${esc(state.objectiveName)}</strong>
    </div>

    <div class="lst-extraction-status lst-extraction-${statusClass}">
      ${objectiveStatus}
    </div>

    <div class="lst-extraction-grid">
      <div class="lst-extraction-stat">
        <span>OBJECTIVE IN EZ</span>
        <strong>${state.objectiveInExtraction ? "YES" : "NO"}</strong>
      </div>

      <div class="lst-extraction-stat allied">
        <span>ALLIES IN EZ</span>
        <strong>${state.friendlyInExtractionZone}</strong>
      </div>

      <div class="lst-extraction-stat allied">
        <span>ADJACENT ALLIES</span>
        <strong>${state.friendlyAdjacent}</strong>
      </div>

      <div class="lst-extraction-stat hostile">
        <span>ADJACENT HOSTILES</span>
        <strong>${state.hostileAdjacent}</strong>
      </div>
    </div>
  `;
}

function renderEscortState(sitrep, state) {
  let objectiveStatus = "IN TRANSIT";
  let statusClass = "active";

  if (state.objectiveExtracted) {
    objectiveStatus = "SAFELY EXTRACTED";
    statusClass = "extracted";
  } else if (state.objectiveDestroyed) {
    objectiveStatus = "DESTROYED";
    statusClass = "destroyed";
  } else if (state.canExtractObjective) {
    objectiveStatus = "READY TO EXTRACT";
    statusClass = "ready";
  } else if (state.objectiveInExtraction) {
    objectiveStatus = "EXTRACTION CONTESTED";
    statusClass = "contested";
  }

  return `
    <div class="lst-escort-objective">
      <span>OBJECTIVE</span>
      <strong>${esc(state.objectiveName)}</strong>
    </div>

    <div class="lst-escort-status lst-escort-${statusClass}">
      ${objectiveStatus}
    </div>

    <div class="lst-escort-grid">
      <div class="lst-escort-stat">
        <span>IN EXTRACTION ZONE</span>
        <strong>${state.objectiveInExtraction ? "YES" : "NO"}</strong>
      </div>

      <div class="lst-escort-stat allied">
        <span>ADJACENT ALLIES</span>
        <strong>${state.friendlyAdjacent}</strong>
      </div>

      <div class="lst-escort-stat hostile">
        <span>ADJACENT HOSTILES</span>
        <strong>${state.hostileAdjacent}</strong>
      </div>

      <div class="lst-escort-stat">
        <span>EXTRACTION</span>
        <strong>${state.canExtractObjective ? "CLEAR" : "BLOCKED"}</strong>
      </div>
    </div>
  `;
}

function renderControlState(sitrep, state) {
  const zones = state.controlZones
    .map(
      (zone, index) => `
        <div class="lst-control-zone lst-zone-${esc(zone.controller)}">
          <div class="lst-control-zone-name">
            OBJECTIVE ${String.fromCharCode(65 + index)}
          </div>

          <strong>${esc(zone.name)}</strong>

          <div class="lst-control-zone-status">
            ${controlZoneLabel(zone.controller)}
          </div>

          <div class="lst-control-zone-counts">
            <span class="allied">${zone.friendly} ALLIED</span>
            <span class="hostile">${zone.hostile} HOSTILE</span>
          </div>
        </div>
      `
    )
    .join("");

  return `
    <div class="lst-control-scoreboard">
      <div class="lst-control-score allied">
        <span>ALLIED SCORE</span>
        <strong>${state.friendlyScore}</strong>
      </div>

      <div class="lst-control-score hostile">
        <span>HOSTILE SCORE</span>
        <strong>${state.hostileScore}</strong>
      </div>
    </div>

    <div class="lst-control-round-zones">
      <span>ALLIED ZONES: ${state.friendlyZones}</span>
      <span>HOSTILE ZONES: ${state.hostileZones}</span>
    </div>

    <div class="lst-control-zone-grid">
      ${zones}
    </div>
  `;
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
          ? sitrep.type === "control"
            ? renderControlState(sitrep, state)
            : sitrep.type === "escort"
              ? renderEscortState(sitrep, state)
              : sitrep.type === "extraction"
                ? renderExtractionState(sitrep, state)
                : `
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
              ${
                sitrep.type === "control"
                  ? "Control requires exactly four valid Scene Regions."
                  : sitrep.type === "escort"
                    ? "Escort requires a valid Objective combatant and Extraction Zone Region."
                    : sitrep.type === "extraction"
                      ? "Extraction requires a valid Objective combatant and Extraction Zone Region."
                      : "The configured Region cannot be found on this combat's Scene."
              }
            </div>
          `
      }

      ${
        game.user.isGM && sitrep.type === "extraction"
          ? `
            <div class="lst-extraction-controls">
              <button
                type="button"
                data-action="extraction-extract"
                ${
                  !state.canExtractObjective ||
                  state.objectiveDestroyed ||
                  state.objectiveExtracted
                    ? "disabled"
                    : ""
                }
              >
                Extract Objective
              </button>

              <button
                type="button"
                data-action="extraction-destroy"
                ${
                  state.objectiveDestroyed ||
                  state.objectiveExtracted
                    ? "disabled"
                    : ""
                }
              >
                Destroy Objective
              </button>
            </div>
          `
          : ""
      }

      ${
        game.user.isGM && sitrep.type === "escort"
          ? `
            <div class="lst-escort-controls">
              <button
                type="button"
                data-action="escort-extract"
                ${state.objectiveDestroyed || state.objectiveExtracted ? "disabled" : ""}
              >
                Extract Objective
              </button>

              <button
                type="button"
                data-action="escort-destroy"
                ${state.objectiveDestroyed || state.objectiveExtracted ? "disabled" : ""}
              >
                Destroy Objective
              </button>
            </div>
          `
          : ""
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
    .querySelector('[data-action="extraction-extract"]')
    ?.addEventListener(
      "click",
      () => resolveExtractionObjective("extracted")
    );

  hud
    .querySelector('[data-action="extraction-destroy"]')
    ?.addEventListener(
      "click",
      () => resolveExtractionObjective("destroyed")
    );

  hud
    .querySelector('[data-action="escort-extract"]')
    ?.addEventListener(
      "click",
      () => resolveEscortObjective("extracted")
    );

  hud
    .querySelector('[data-action="escort-destroy"]')
    ?.addEventListener(
      "click",
      () => resolveEscortObjective("destroyed")
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
  let sitrep = getSitrep(combat);

  if (
    !sitrep?.active ||
    sitrep.status !== "active" ||
    !isPrimaryGM()
  ) {
    return;
  }

  let state = calculateState(combat, sitrep);
  if (!state.valid) return;

  const roundChanged = Object.prototype.hasOwnProperty.call(
    changes,
    "round"
  );

  if (sitrep.type === "extraction") {
    if (state.objectiveDestroyed) {
      if (sitrep.extractionStatus !== "destroyed") {
        await resolveExtractionObjective("destroyed");
      }

      return;
    }

    if (
      roundChanged &&
      Number(changes.round) > Number(sitrep.finalRound)
    ) {
      await setResult(
        "defeat",
        `The Objective was not extracted by the end of round ${sitrep.finalRound}. Any allied units remaining on the battlefield are captured or overrun.`
      );
    }

    return;
  }

  if (sitrep.type === "escort") {
    if (state.objectiveDestroyed) {
      if (sitrep.escortStatus !== "destroyed") {
        await resolveEscortObjective("destroyed");
      }

      return;
    }

    if (state.canExtractObjective) {
      await resolveEscortObjective("extracted");
      return;
    }

    if (
      roundChanged &&
      Number(changes.round) > Number(sitrep.finalRound)
    ) {
      await setResult(
        "defeat",
        `The Objective was not extracted by the end of round ${sitrep.finalRound}.`
      );
    }

    return;
  }

  if (sitrep.type === "control") {
    if (!roundChanged) return;

    const completedRound = Number(changes.round) - 1;
    const scoredRounds = Array.isArray(sitrep.scoredRounds)
      ? [...sitrep.scoredRounds]
      : [];

    if (
      completedRound >= Number(sitrep.startRound) &&
      completedRound <= Number(sitrep.finalRound) &&
      !scoredRounds.includes(completedRound)
    ) {
      let friendlyRoundPoints = state.friendlyZones;
      let hostileRoundPoints = state.hostileZones;

      if (state.friendlyZones === 4) friendlyRoundPoints += 1;
      if (state.hostileZones === 4) hostileRoundPoints += 1;

      scoredRounds.push(completedRound);

      sitrep = {
        ...sitrep,
        scores: {
          friendly:
            Number(sitrep.scores?.friendly ?? 0) +
            friendlyRoundPoints,
          hostile:
            Number(sitrep.scores?.hostile ?? 0) +
            hostileRoundPoints
        },
        scoredRounds
      };

      await combat.setFlag(MODULE_ID, FLAG_KEY, sitrep);
      state = calculateState(combat, sitrep);

      await ChatMessage.create({
        speaker: { alias: "MISSION CONTROL" },
        content: `
          <div class="lst-chat-result">
            <strong>CONTROL — ROUND ${completedRound} SCORED</strong>
            <br>
            Allies +${friendlyRoundPoints} | Hostiles +${hostileRoundPoints}
            <br>
            Total: Allies ${sitrep.scores.friendly} — Hostiles ${sitrep.scores.hostile}
          </div>
        `
      });
    }

    if (Number(changes.round) > Number(sitrep.finalRound)) {
      const friendlyScore = Number(sitrep.scores?.friendly ?? 0);
      const hostileScore = Number(sitrep.scores?.hostile ?? 0);

      if (friendlyScore > hostileScore) {
        await setResult(
          "victory",
          `The allies won Control ${friendlyScore} to ${hostileScore}.`
        );
      } else if (hostileScore > friendlyScore) {
        await setResult(
          "defeat",
          `The hostiles won Control ${hostileScore} to ${friendlyScore}.`
        );
      } else {
        await combat.setFlag(MODULE_ID, FLAG_KEY, {
          ...sitrep,
          status: "draw",
          resultReason:
            `Control ended in a ${friendlyScore} to ${hostileScore} draw. Neither side achieved victory.`
        });

        await ChatMessage.create({
          speaker: { alias: "MISSION CONTROL" },
          content: `
            <div class="lst-chat-result">
              <strong>NO VICTOR</strong>
              <br>
              Control ended in a ${friendlyScore} to ${hostileScore} draw.
            </div>
          `
        });
      }
    }

    return;
  }

  if (state.immediateVictory) {
    await setResult("victory", state.immediateReason);
    return;
  }

  const previousRound = Number(combat.previous?.round ?? 0);

  const advancedPastFinalRound =
    roundChanged &&
    Number(combat.round) > Number(sitrep.finalRound);

  const fallbackPastFinalRound =
    roundChanged &&
    previousRound === Number(sitrep.finalRound) &&
    Number(combat.round) !== previousRound;

  if (advancedPastFinalRound || fallbackPastFinalRound) {
    const won =
      sitrep.rules?.finalZoneControl &&
      state.friendlyInZone > state.hostileInZone &&
      state.friendlyInZone > 0;

    const reason = won
      ? `At the end of round ${sitrep.finalRound}, allied units controlled the zone ${state.friendlyInZone} to ${state.hostileInZone}.`
      : `At the end of round ${sitrep.finalRound}, allied units did not control the zone (${state.friendlyInZone} allied, ${state.hostileInZone} hostile).`;

    await setResult(won ? "victory" : "defeat", reason);
  }
}

async function resolveExtractionObjective(outcome) {
  const combat = activeCombat();
  const sitrep = getSitrep(combat);

  if (
    !game.user.isGM ||
    !combat ||
    !sitrep ||
    sitrep.type !== "extraction"
  ) {
    return;
  }

  if (outcome === "extracted") {
    const state = calculateState(combat, sitrep);

    if (!state.canExtractObjective) {
      ui.notifications.warn(
        "The Objective cannot currently be extracted. It must be inside the Extraction Zone, adjacent to an allied unit, and uncontested."
      );

      return;
    }

    await combat.setFlag(MODULE_ID, FLAG_KEY, {
      ...sitrep,
      extractionStatus: "extracted"
    });

    await setResult(
      "victory",
      "The Objective was safely recovered and extracted."
    );

    return;
  }

  if (outcome === "destroyed") {
    const updatedSitrep = {
      ...sitrep,
      extractionStatus: "destroyed",
      status: "draw",
      resultReason:
        "The Objective was destroyed. Neither side achieved victory."
    };

    await combat.setFlag(
      MODULE_ID,
      FLAG_KEY,
      updatedSitrep
    );

    if (isPrimaryGM()) {
      await ChatMessage.create({
        speaker: {
          alias: "MISSION CONTROL"
        },
        content: `
          <div class="lst-chat-result">
            <strong>NO VICTOR</strong>
            <br>
            The Objective was destroyed.
          </div>
        `
      });
    }
  }
}

async function resolveEscortObjective(outcome) {
  const combat = activeCombat();
  const sitrep = getSitrep(combat);

  if (
    !game.user.isGM ||
    !combat ||
    !sitrep ||
    sitrep.type !== "escort"
  ) {
    return;
  }

  if (outcome === "extracted") {
    await combat.setFlag(MODULE_ID, FLAG_KEY, {
      ...sitrep,
      escortStatus: "extracted"
    });

    await setResult(
      "victory",
      "The Objective was safely extracted."
    );

    return;
  }

  if (outcome === "destroyed") {
    const updatedSitrep = {
      ...sitrep,
      escortStatus: "destroyed",
      status: "draw",
      resultReason:
        "The Objective was destroyed. Neither side achieved victory."
    };

    await combat.setFlag(
      MODULE_ID,
      FLAG_KEY,
      updatedSitrep
    );

    if (isPrimaryGM()) {
      await ChatMessage.create({
        speaker: {
          alias: "MISSION CONTROL"
        },
        content: `
          <div class="lst-chat-result">
            <strong>NO VICTOR</strong>
            <br>
            The Objective was destroyed.
          </div>
        `
      });
    }
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

  const selectedControlRegionIds = Array.isArray(existing?.controlRegionIds)
    ? existing.controlRegionIds
    : [];

  const controlRegionOptions = regions
    .map(
      region => `
        <option
          value="${esc(region.id)}"
          ${selectedControlRegionIds.includes(region.id) ? "selected" : ""}
        >
          ${esc(region.name || region.id)}
        </option>
      `
    )
    .join("");

  const escortExtractionOptions = regions
    .map(
      region => `
        <option
          value="${esc(region.id)}"
          ${
            existing?.escortExtractionRegionId === region.id
              ? "selected"
              : ""
          }
        >
          ${esc(region.name || region.id)}
        </option>
      `
    )
    .join("");

  const escortObjectiveOptions = [...(combat.combatants ?? [])]
    .map(
      combatant => `
        <option
          value="${esc(combatant.id)}"
          ${
            existing?.escortObjectiveCombatantId === combatant.id
              ? "selected"
              : ""
          }
        >
          ${esc(combatant.name || combatant.token?.name || combatant.id)}
        </option>
      `
    )
    .join("");

  const extractionZoneOptions = regions
    .map(
      region => `
        <option
          value="${esc(region.id)}"
          ${
            existing?.extractionZoneRegionId === region.id
              ? "selected"
              : ""
          }
        >
          ${esc(region.name || region.id)}
        </option>
      `
    )
    .join("");

  const extractionObjectiveOptions = [...(combat.combatants ?? [])]
    .map(
      combatant => `
        <option
          value="${esc(combatant.id)}"
          ${
            existing?.extractionObjectiveCombatantId === combatant.id
              ? "selected"
              : ""
          }
        >
          ${esc(combatant.name || combatant.token?.name || combatant.id)}
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

      <div class="form-group lst-single-region-group">
        <label>Control Region</label>

        <select name="regionId">
          <option value="">
            — Select a Region —
          </option>

          ${regionOptions}
        </select>
      </div>

      <div class="form-group lst-control-regions-group" style="display: none;">
        <label>Control Zones</label>

        <select name="controlRegionIds" multiple size="6">
          ${controlRegionOptions}
        </select>

        <p class="notes">
          Select exactly four Scene Regions. Hold Ctrl while clicking
          to select multiple Regions.
        </p>
      </div>

      <div class="lst-extraction-fields" style="display: none;">
        <div class="form-group">
          <label>Objective combatant</label>

          <select name="extractionObjectiveCombatantId">
            <option value="">
              — Select the Objective —
            </option>

            ${extractionObjectiveOptions}
          </select>

          <p class="notes">
            Add the Objective token to the Combat Tracker, then select it here.
          </p>
        </div>

        <div class="form-group">
          <label>Extraction Zone</label>

          <select name="extractionZoneRegionId">
            <option value="">
              — Select the Extraction Zone —
            </option>

            ${extractionZoneOptions}
          </select>

          <p class="notes">
            The Objective must reach this Region while adjacent to an allied unit and uncontested.
          </p>
        </div>
      </div>

      <div class="lst-escort-fields" style="display: none;">
        <div class="form-group">
          <label>Objective combatant</label>

          <select name="escortObjectiveCombatantId">
            <option value="">
              — Select the Objective —
            </option>

            ${escortObjectiveOptions}
          </select>

          <p class="notes">
            Add the Objective token to the Combat Tracker, then select it here.
          </p>
        </div>

        <div class="form-group">
          <label>Extraction Zone</label>

          <select name="escortExtractionRegionId">
            <option value="">
              — Select the Extraction Zone —
            </option>

            ${escortExtractionOptions}
          </select>
        </div>
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

  const sitrepType = String(
    formData.get("sitrepType") || DEFAULTS.type
  );

  const regionId = String(
    formData.get("regionId") ?? ""
  );

  const controlRegionIds = formData
    .getAll("controlRegionIds")
    .map(String);

  const escortObjectiveCombatantId = String(
    formData.get("escortObjectiveCombatantId") ?? ""
  );

  const escortExtractionRegionId = String(
    formData.get("escortExtractionRegionId") ?? ""
  );

  const extractionObjectiveCombatantId = String(
    formData.get("extractionObjectiveCombatantId") ?? ""
  );

  const extractionZoneRegionId = String(
    formData.get("extractionZoneRegionId") ?? ""
  );

  if (sitrepType === "control") {
    if (controlRegionIds.length !== 4) {
      ui.notifications.error(
        "Control requires exactly four selected Scene Regions."
      );

      return false;
    }
  } else if (sitrepType === "extraction") {
    if (!extractionObjectiveCombatantId) {
      ui.notifications.error(
        "Extraction requires an Objective combatant."
      );

      return false;
    }

    if (!extractionZoneRegionId) {
      ui.notifications.error(
        "Extraction requires an Extraction Zone Region."
      );

      return false;
    }
  } else if (sitrepType === "escort") {
    if (!escortObjectiveCombatantId) {
      ui.notifications.error(
        "Escort requires an Objective combatant."
      );

      return false;
    }

    if (!escortExtractionRegionId) {
      ui.notifications.error(
        "Escort requires an Extraction Zone Region."
      );

      return false;
    }
  } else if (!regionId) {
    ui.notifications.error(
      "Select a control Region."
    );

    return false;
  }

  const roundLimit = Math.max(
    Number(
      formData.get("roundLimit") ??
      (sitrepType === "control" ? 6 : 8)
    ),
    1
  );

  const startRound = Math.max(
    Number(combat.round ?? 1),
    1
  );

  const data = {
    ...DEFAULTS,

    type: sitrepType,

    controlRegionIds:
      sitrepType === "control"
        ? controlRegionIds
        : [],

    scores: {
      friendly: 0,
      hostile: 0
    },

    scoredRounds: [],

    escortObjectiveCombatantId:
      sitrepType === "escort"
        ? escortObjectiveCombatantId
        : "",

    escortExtractionRegionId:
      sitrepType === "escort"
        ? escortExtractionRegionId
        : "",

    escortStatus: "active",

    extractionObjectiveCombatantId:
      sitrepType === "extraction"
        ? extractionObjectiveCombatantId
        : "",

    extractionZoneRegionId:
      sitrepType === "extraction"
        ? extractionZoneRegionId
        : "",

    extractionStatus: "active",

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

      render: html => {
        const root = html[0] ?? html;
        const app = html.closest?.(".app");
        app?.addClass?.("lst-dialog");

        const typeSelect = root.querySelector('[name="sitrepType"]');
        const roundLimitInput = root.querySelector('[name="roundLimit"]');
        const singleRegionGroup = root.querySelector(".lst-single-region-group");
        const controlRegionsGroup = root.querySelector(".lst-control-regions-group");
        const escortFields = root.querySelector(".lst-escort-fields");
        const extractionFields = root.querySelector(".lst-extraction-fields");

        const updateSitrepFields = () => {
          const isControl = typeSelect?.value === "control";
          const isEscort = typeSelect?.value === "escort";
          const isExtraction = typeSelect?.value === "extraction";
          const usesSingleRegion =
            !isControl &&
            !isEscort &&
            !isExtraction;

          if (singleRegionGroup) {
            singleRegionGroup.style.display = usesSingleRegion ? "" : "none";
          }

          if (controlRegionsGroup) {
            controlRegionsGroup.style.display = isControl ? "" : "none";
          }

          if (escortFields) {
            escortFields.style.display = isEscort ? "" : "none";
          }

          if (extractionFields) {
            extractionFields.style.display = isExtraction ? "" : "none";
          }

          if (roundLimitInput && !existing) {
            roundLimitInput.value = isControl
              ? "6"
              : isExtraction
                ? "10"
                : "8";
          }
        };

        typeSelect?.addEventListener("change", updateSitrepFields);
        updateSitrepFields();
      }
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
