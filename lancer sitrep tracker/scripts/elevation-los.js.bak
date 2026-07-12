const MODULE_ID = "lancer-sitrep-tracker";
const FEATURE_KEY = "elevationLOS";
const STYLE_ID = "lancer-elevation-los-styles";

/* ==========================================================
   Wall elevation data
   ========================================================== */

function finiteNumberOr(value, fallback) {
  if (value === "" || value === null || value === undefined) {
    return fallback;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function wallElevationRange(wallDocument) {
  const data = wallDocument?.getFlag?.(
    MODULE_ID,
    FEATURE_KEY
  ) ?? {};

  return {
    bottom: finiteNumberOr(
      data.bottom,
      Number.NEGATIVE_INFINITY
    ),

    top: finiteNumberOr(
      data.top,
      Number.POSITIVE_INFINITY
    )
  };
}

function wallHasFiniteElevation(wallDocument) {
  const range = wallElevationRange(wallDocument);

  return (
    Number.isFinite(range.bottom) ||
    Number.isFinite(range.top)
  );
}

function viewingElevationFromPolygon(polygon) {
  const source = polygon?.config?.source;

  const tokenDocument =
    source?.object?.document ??
    source?.object ??
    source?.document ??
    source?.token?.document ??
    source?.token ??
    null;

  if (!tokenDocument) return null;

  const documentName =
    tokenDocument.documentName ??
    tokenDocument.constructor?.documentName;

  if (documentName !== "Token") return null;

  return finiteNumberOr(
    tokenDocument.elevation ?? source?.elevation,
    0
  );
}

function wallDocumentFromEdge(edge) {
  const candidates = [
    edge?.object?.document,
    edge?.object,
    edge?.wall?.document,
    edge?.wall,
    edge?.document,
    edge
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;

    const documentName =
      candidate.documentName ??
      candidate.constructor?.documentName;

    if (documentName === "Wall") {
      return candidate;
    }
  }

  return null;
}

function wallBlocksElevation(wallDocument, elevation) {
  if (!wallDocument) return true;

  const { bottom, top } =
    wallElevationRange(wallDocument);

  /*
   * Unconfigured walls remain infinitely tall and behave exactly
   * like ordinary Foundry walls.
   *
   * A wall blocks sight while the viewer's elevation lies inside
   * its vertical span. The upper boundary is exclusive, so a token
   * at elevation 3 can see over a wall whose top is elevation 3.
   */
  return elevation >= bottom && elevation < top;
}

/* ==========================================================
   Vision polygon integration
   ========================================================== */

function installVisionPolygonWrapper() {
  const PolygonClass =
    foundry?.canvas?.geometry?.ClockwiseSweepPolygon ??
    globalThis.ClockwiseSweepPolygon;

  const prototype = PolygonClass?.prototype;

  if (!prototype) {
    console.error(
      `${MODULE_ID} | Could not locate ClockwiseSweepPolygon.`
    );

    return false;
  }

  if (prototype.__lancerElevationLOSWrapped) {
    return true;
  }

  const methodName =
    typeof prototype._testEdgeInclusion === "function"
      ? "_testEdgeInclusion"
      : typeof prototype._testWallInclusion === "function"
        ? "_testWallInclusion"
        : null;

  if (!methodName) {
    console.error(
      `${MODULE_ID} | Foundry's wall-inclusion method could not be located.`
    );

    return false;
  }

  const original = prototype[methodName];

  prototype[methodName] = function (...args) {
    try {
      const restrictionType =
        this?.config?.type ??
        this?.config?.wallRestrictionType ??
        "sight";

      /*
       * Elevation changes sight only. Movement, sound, and other
       * collision polygons continue using ordinary Foundry walls.
       */
      const isSightPolygon =
        restrictionType === "sight" ||
        restrictionType === "vision";

      if (isSightPolygon) {
        const viewerElevation =
          viewingElevationFromPolygon(this);

        if (viewerElevation !== null) {
          const wallDocument =
            wallDocumentFromEdge(args[0]);

          if (
            wallDocument &&
            wallHasFiniteElevation(wallDocument) &&
            !wallBlocksElevation(
              wallDocument,
              viewerElevation
            )
          ) {
            return false;
          }
        }
      }
    } catch (error) {
      console.warn(
        `${MODULE_ID} | Elevation LOS wall test failed; using normal Foundry behavior.`,
        error
      );
    }

    return original.apply(this, args);
  };

  Object.defineProperty(
    prototype,
    "__lancerElevationLOSWrapped",
    {
      value: true,
      configurable: true
    }
  );

  console.log(
    `${MODULE_ID} | Elevation-aware LOS installed using ${methodName}.`
  );

  return true;
}

/* ==========================================================
   Vision and fog refresh
   ========================================================== */

function refreshElevationVision() {
  if (!canvas?.ready) return;

  clearTimeout(
    globalThis.__lancerElevationLOSRefresh
  );

  globalThis.__lancerElevationLOSRefresh =
    setTimeout(() => {
      try {
        canvas.perception?.update?.(
          {
            initializeVision: true,
            refreshVision: true,
            refreshLighting: true,
            refreshOcclusion: true
          },
          true
        );
      } catch (error) {
        console.warn(
          `${MODULE_ID} | Perception update failed; attempting fallback refresh.`,
          error
        );

        try {
          canvas.effects?.visibility?.refresh?.();
          canvas.visibility?.refresh?.();
        } catch (fallbackError) {
          console.error(
            `${MODULE_ID} | Vision refresh failed.`,
            fallbackError
          );
        }
      }
    }, 75);
}

/* ==========================================================
   Wall configuration UI
   ========================================================== */

function wallConfigRoot(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  return null;
}

function installStyles() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;

  style.textContent = `
    .lancer-elevation-los-fieldset {
      margin: 10px 0;
      padding: 10px 12px;
      border: 1px solid rgba(86, 228, 255, 0.45);
      background: rgba(86, 228, 255, 0.045);
    }

    .lancer-elevation-los-fieldset legend {
      padding: 0 6px;
      color: #56e4ff;
      font-weight: 700;
    }

    .lancer-elevation-los-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .lancer-elevation-los-fieldset .notes {
      margin: 6px 0 0;
      font-size: 11px;
      line-height: 1.35;
    }

    .lancer-elevation-los-presets {
      display: flex;
      gap: 6px;
      margin-top: 8px;
    }

    .lancer-elevation-los-presets button {
      flex: 1;
      min-width: 0;
      padding: 4px 3px;
      font-size: 10px;
    }
  `;

  document.head.appendChild(style);
}

function injectWallElevationFields(app, html) {
  if (!game.user?.isGM) return;

  const root = wallConfigRoot(html);
  if (!root) return;

  if (
    root.querySelector(
      ".lancer-elevation-los-fieldset"
    )
  ) {
    return;
  }

  const wallDocument =
    app?.document ??
    app?.object ??
    null;

  if (!wallDocument) return;

  const stored = wallDocument.getFlag?.(
    MODULE_ID,
    FEATURE_KEY
  ) ?? {};

  const bottomValue =
    stored.bottom === null ||
    stored.bottom === undefined
      ? ""
      : String(stored.bottom);

  const topValue =
    stored.top === null ||
    stored.top === undefined
      ? ""
      : String(stored.top);

  const fieldset = document.createElement("fieldset");
  fieldset.className =
    "lancer-elevation-los-fieldset";

  fieldset.innerHTML = `
    <legend>
      <i class="fas fa-layer-group"></i>
      Lancer Elevation LOS
    </legend>

    <div class="lancer-elevation-los-grid">
      <div class="form-group">
        <label>Bottom Elevation</label>
        <div class="form-fields">
          <input
            type="number"
            step="any"
            name="flags.${MODULE_ID}.${FEATURE_KEY}.bottom"
            value="${foundry.utils.escapeHTML(bottomValue)}"
            placeholder="No lower limit"
          >
        </div>
      </div>

      <div class="form-group">
        <label>Top Elevation</label>
        <div class="form-fields">
          <input
            type="number"
            step="any"
            name="flags.${MODULE_ID}.${FEATURE_KEY}.top"
            value="${foundry.utils.escapeHTML(topValue)}"
            placeholder="Infinite"
          >
        </div>
      </div>
    </div>

    <p class="notes">
      The wall blocks sight only while a viewing token's elevation
      is inside this range. Leave both fields blank for an ordinary
      infinitely tall Foundry wall. This does not change movement
      collision.
    </p>

    <div class="lancer-elevation-los-presets">
      <button type="button" data-elevation-preset="1">
        Height 1
      </button>

      <button type="button" data-elevation-preset="2">
        Height 2
      </button>

      <button type="button" data-elevation-preset="3">
        Height 3
      </button>

      <button type="button" data-elevation-preset="5">
        Height 5
      </button>

      <button type="button" data-elevation-preset="infinite">
        Infinite
      </button>
    </div>
  `;

  const form =
    root.matches?.("form")
      ? root
      : root.querySelector("form");

  const footer = form?.querySelector(
    ".form-footer, footer"
  );

  if (footer) {
    footer.before(fieldset);
  } else {
    form?.appendChild(fieldset);
  }

  const bottomInput = fieldset.querySelector(
    `[name="flags.${MODULE_ID}.${FEATURE_KEY}.bottom"]`
  );

  const topInput = fieldset.querySelector(
    `[name="flags.${MODULE_ID}.${FEATURE_KEY}.top"]`
  );

  fieldset
    .querySelectorAll("[data-elevation-preset]")
    .forEach(button => {
      button.addEventListener("click", () => {
        const preset = button.dataset.elevationPreset;

        if (preset === "infinite") {
          bottomInput.value = "";
          topInput.value = "";
          return;
        }

        bottomInput.value = "0";
        topInput.value = preset;
      });
    });
}

/* ==========================================================
   Public helpers and bulk editing
   ========================================================== */

async function setWallRange(
  wallDocument,
  bottom,
  top
) {
  if (!game.user?.isGM || !wallDocument) return;

  await wallDocument.setFlag(
    MODULE_ID,
    FEATURE_KEY,
    {
      bottom:
        bottom === "" || bottom === null
          ? ""
          : Number(bottom),

      top:
        top === "" || top === null
          ? ""
          : Number(top)
    }
  );

  refreshElevationVision();
}

async function setSelectedWallRange(bottom, top) {
  if (!game.user?.isGM) {
    return ui.notifications.warn(
      "Only a GM can configure wall elevations."
    );
  }

  const controlledWalls =
    canvas?.walls?.controlled ?? [];

  if (!controlledWalls.length) {
    return ui.notifications.warn(
      "Select one or more walls first."
    );
  }

  const updates = controlledWalls.map(wall => ({
    _id: wall.document.id,
    [`flags.${MODULE_ID}.${FEATURE_KEY}`]: {
      bottom:
        bottom === "" || bottom === null
          ? ""
          : Number(bottom),

      top:
        top === "" || top === null
          ? ""
          : Number(top)
    }
  }));

  await canvas.scene.updateEmbeddedDocuments(
    "Wall",
    updates
  );

  refreshElevationVision();

  ui.notifications.info(
    `Updated elevation range for ${updates.length} wall(s).`
  );
}

/* ==========================================================
   Foundry hooks
   ========================================================== */

Hooks.once("init", () => {
  installStyles();
  installVisionPolygonWrapper();
});

Hooks.once("ready", () => {
  game.lancerElevationLOS = {
    refresh: refreshElevationVision,
    getWallRange: wallElevationRange,
    setWallRange,
    setSelectedWallRange
  };

  refreshElevationVision();
});

Hooks.on(
  "renderWallConfig",
  injectWallElevationFields
);

Hooks.on(
  "updateToken",
  (tokenDocument, changes) => {
    if (
      Object.prototype.hasOwnProperty.call(
        changes,
        "elevation"
      )
    ) {
      refreshElevationVision();
    }
  }
);

Hooks.on(
  "updateWall",
  (wallDocument, changes) => {
    const changedElevationData =
      foundry.utils.hasProperty(
        changes,
        `flags.${MODULE_ID}.${FEATURE_KEY}`
      );

    if (
      changedElevationData ||
      Object.prototype.hasOwnProperty.call(changes, "c") ||
      Object.prototype.hasOwnProperty.call(changes, "sight") ||
      Object.prototype.hasOwnProperty.call(changes, "door") ||
      Object.prototype.hasOwnProperty.call(changes, "ds")
    ) {
      refreshElevationVision();
    }
  }
);

Hooks.on(
  "createWall",
  refreshElevationVision
);

Hooks.on(
  "deleteWall",
  refreshElevationVision
);

Hooks.on(
  "canvasReady",
  refreshElevationVision
);
