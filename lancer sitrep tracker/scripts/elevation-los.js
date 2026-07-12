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

function sourceDocumentFromPolygon(polygon) {
  const source = polygon?.config?.source;

  const candidates = [
    source?.object?.document,
    source?.object,
    source?.document,
    source?.token?.document,
    source?.token,
    source?.light?.document,
    source?.light,
    source?.ambientLight?.document,
    source?.ambientLight
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;

    const documentName =
      candidate.documentName ??
      candidate.constructor?.documentName;

    if (
      documentName === "Token" ||
      documentName === "AmbientLight"
    ) {
      return candidate;
    }
  }

  return null;
}

function sourceElevationFromPolygon(polygon) {
  const source = polygon?.config?.source;
  const sourceDocument = sourceDocumentFromPolygon(polygon);

  if (!sourceDocument) return null;

  return finiteNumberOr(
    sourceDocument.elevation ??
    source?.elevation ??
    source?.data?.elevation,
    0
  );
}

/* ==========================================================
   Three-dimensional ambient-light radius
   ========================================================== */

const LIGHT_GROUND_ELEVATION = 0;

function horizontalRadiusAtGround(
  sphericalRadius,
  lightElevation,
  groundElevation = LIGHT_GROUND_ELEVATION
) {
  const radius = Math.abs(
    finiteNumberOr(sphericalRadius, 0)
  );

  const verticalDistance = Math.abs(
    finiteNumberOr(lightElevation, 0) -
    finiteNumberOr(groundElevation, 0)
  );

  if (radius <= 0 || verticalDistance >= radius) {
    return 0;
  }

  return Math.sqrt(
    Math.max(
      0,
      radius * radius -
      verticalDistance * verticalDistance
    )
  );
}

function sceneDistanceToPixels(distance) {
  const gridSize = finiteNumberOr(
    canvas?.dimensions?.size ??
    canvas?.scene?.grid?.size,
    100
  );

  const gridDistance = finiteNumberOr(
    canvas?.dimensions?.distance ??
    canvas?.scene?.grid?.distance,
    1
  );

  if (gridDistance === 0) return distance;

  return distance * gridSize / gridDistance;
}

function preserveRadiusSign(originalRadius, adjustedRadius) {
  const original = finiteNumberOr(originalRadius, 0);
  const sign = original < 0 ? -1 : 1;

  return adjustedRadius * sign;
}

function radiusValueForReturnedUnits(
  returnedValue,
  configuredRadius,
  horizontalSceneRadius
) {
  const returned = Math.abs(
    finiteNumberOr(returnedValue, 0)
  );

  const configured = Math.abs(
    finiteNumberOr(configuredRadius, 0)
  );

  const horizontalPixels = sceneDistanceToPixels(
    horizontalSceneRadius
  );

  /*
   * Foundry versions may expose source radius data in either
   * Scene-distance units or canvas pixels. Compare the returned
   * value to both possibilities and preserve the unit convention
   * used by the current Foundry build.
   */
  const configuredPixels = sceneDistanceToPixels(configured);

  const sceneUnitDifference = Math.abs(
    returned - configured
  );

  const pixelDifference = Math.abs(
    returned - configuredPixels
  );

  return sceneUnitDifference <= pixelDifference
    ? horizontalSceneRadius
    : horizontalPixels;
}

function installAmbientLightRadiusWrapper() {
  const AmbientLightClass =
    foundry?.canvas?.placeables?.AmbientLight ??
    globalThis.AmbientLight;

  const prototype = AmbientLightClass?.prototype;

  if (!prototype) {
    console.error(
      `${MODULE_ID} | Could not locate the AmbientLight class.`
    );

    return false;
  }

  if (prototype.__lancer3DLightRadiusWrapped) {
    return true;
  }

  const original = prototype._getLightSourceData;

  if (typeof original !== "function") {
    console.error(
      `${MODULE_ID} | AmbientLight._getLightSourceData could not be located.`
    );

    return false;
  }

  prototype._getLightSourceData = function (...args) {
    const originalData = original.apply(this, args);

    if (!originalData || typeof originalData !== "object") {
      return originalData;
    }

    const data = {
      ...originalData
    };

    const elevation = finiteNumberOr(
      this.document?.elevation ??
      originalData.elevation,
      0
    );

    const configuredBright = finiteNumberOr(
      this.config?.bright ??
      this.document?.config?.bright,
      0
    );

    const configuredDim = finiteNumberOr(
      this.config?.dim ??
      this.document?.config?.dim,
      0
    );

    const horizontalBright = horizontalRadiusAtGround(
      configuredBright,
      elevation
    );

    const horizontalDim = horizontalRadiusAtGround(
      configuredDim,
      elevation
    );

    if (
      Object.prototype.hasOwnProperty.call(
        data,
        "bright"
      )
    ) {
      const adjustedBright = radiusValueForReturnedUnits(
        data.bright,
        configuredBright,
        horizontalBright
      );

      data.bright = preserveRadiusSign(
        data.bright,
        adjustedBright
      );
    }

    if (
      Object.prototype.hasOwnProperty.call(
        data,
        "dim"
      )
    ) {
      const adjustedDim = radiusValueForReturnedUnits(
        data.dim,
        configuredDim,
        horizontalDim
      );

      data.dim = preserveRadiusSign(
        data.dim,
        adjustedDim
      );
    }

    const maximumHorizontalRadius = Math.max(
      horizontalBright,
      horizontalDim
    );

    const maximumHorizontalPixels =
      sceneDistanceToPixels(maximumHorizontalRadius);

    if (
      Object.prototype.hasOwnProperty.call(
        data,
        "radius"
      )
    ) {
      data.radius = maximumHorizontalPixels;
    }

    if (
      Object.prototype.hasOwnProperty.call(
        data,
        "externalRadius"
      )
    ) {
      data.externalRadius = maximumHorizontalPixels;
    }

    return data;
  };

  Object.defineProperty(
    prototype,
    "__lancer3DLightRadiusWrapped",
    {
      value: true,
      configurable: true
    }
  );

  console.log(
    `${MODULE_ID} | Three-dimensional ambient-light radius installed.`
  );

  return true;
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
   * A wall blocks sight and movement while the token's elevation
   * lies inside its vertical span. The upper boundary is exclusive,
   * so a token at elevation 3 can see and move over a wall whose
   * top is elevation 3.
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
      const restrictionType = String(
        this?.config?.type ??
        this?.config?.wallRestrictionType ??
        "sight"
      ).toLowerCase();

      /*
       * Elevation affects both vision polygons and movement
       * collision polygons. Sound and unrelated collision types
       * continue using ordinary Foundry wall behavior.
       */
      const isElevationAwarePolygon = [
        "sight",
        "vision",
        "move",
        "movement",
        "light",
        "illumination"
      ].includes(restrictionType);

      if (isElevationAwarePolygon) {
        const sourceElevation =
          sourceElevationFromPolygon(this);

        if (sourceElevation !== null) {
          const wallDocument =
            wallDocumentFromEdge(args[0]);

          if (
            wallDocument &&
            wallHasFiniteElevation(wallDocument) &&
            !wallBlocksElevation(
              wallDocument,
              sourceElevation
            )
          ) {
            /*
             * Returning false excludes this wall from the polygon.
             *
             * Token vision can see over it.
             * Token movement can pass over or beneath it.
             * Ambient light can shine over or beneath it.
             */
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
      The wall blocks sight and movement only while a token's
      elevation is inside this range. A token at or above the Top
      Elevation can see and move over it. Leave both fields blank
      for an ordinary infinitely tall Foundry wall.
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
   Ambient light elevation configuration
   ========================================================== */

function injectAmbientLightElevationField(app, html) {
  if (!game.user?.isGM) return;

  const root = wallConfigRoot(html);
  if (!root) return;

  if (
    root.querySelector(
      ".lancer-light-elevation-fieldset"
    )
  ) {
    return;
  }

  const lightDocument =
    app?.document ??
    app?.object ??
    null;

  if (!lightDocument) return;

  const documentName =
    lightDocument.documentName ??
    lightDocument.constructor?.documentName;

  if (documentName !== "AmbientLight") return;

  const form =
    root.matches?.("form")
      ? root
      : root.querySelector("form");

  if (!form) return;

  const existingElevationInput =
    form.querySelector('[name="elevation"]');

  if (existingElevationInput) {
    const existingGroup =
      existingElevationInput.closest(".form-group");

    existingGroup?.classList.add(
      "lancer-light-elevation-native-field"
    );

    const existingNotes = document.createElement("p");
    existingNotes.className =
      "notes lancer-light-elevation-notes";

    existingNotes.innerHTML = `
      Elevation defaults to 0. Bright and dim ranges are treated
      as spherical 3D radii projected onto ground elevation 0.
      Raising the light therefore reduces its horizontal footprint.
    `;

    existingGroup?.appendChild(existingNotes);
    return;
  }

  const fieldset = document.createElement("fieldset");

  fieldset.className =
    "lancer-elevation-los-fieldset lancer-light-elevation-fieldset";

  fieldset.innerHTML = `
    <legend>
      <i class="fas fa-lightbulb"></i>
      Lancer Light Elevation
    </legend>

    <div class="form-group">
      <label>Light Elevation</label>

      <div class="form-fields">
        <input
          type="number"
          step="any"
          name="elevation"
          value="${foundry.utils.escapeHTML(
            String(lightDocument.elevation ?? 0)
          )}"
        >
      </div>
    </div>

    <p class="notes">
      The default elevation is 0. Bright and dim ranges are
      spherical 3D radii measured from the light source. Raising
      the light reduces the horizontal area illuminated on ground
      elevation 0. If elevation equals or exceeds a radius, that
      radius no longer reaches the ground.
    </p>

    <p class="notes">
      Wall occlusion also uses this elevation. A light at or above
      a wall's Top Elevation can shine over that wall.
    </p>

    <div class="lancer-elevation-los-presets">
      <button type="button" data-light-elevation="0">
        Ground
      </button>

      <button type="button" data-light-elevation="1">
        Elevation 1
      </button>

      <button type="button" data-light-elevation="2">
        Elevation 2
      </button>

      <button type="button" data-light-elevation="3">
        Elevation 3
      </button>

      <button type="button" data-light-elevation="5">
        Elevation 5
      </button>
    </div>
  `;

  const footer = form.querySelector(
    ".form-footer, footer"
  );

  if (footer) {
    footer.before(fieldset);
  } else {
    form.appendChild(fieldset);
  }

  const elevationInput = fieldset.querySelector(
    '[name="elevation"]'
  );

  fieldset
    .querySelectorAll("[data-light-elevation]")
    .forEach(button => {
      button.addEventListener("click", () => {
        elevationInput.value =
          button.dataset.lightElevation ?? "0";

        elevationInput.dispatchEvent(
          new Event("change", {
            bubbles: true
          })
        );
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

async function setAmbientLightElevation(
  lightDocument,
  elevation
) {
  if (!game.user?.isGM || !lightDocument) return;

  await lightDocument.update({
    elevation: finiteNumberOr(elevation, 0)
  });

  refreshElevationVision();
}

async function setSelectedLightElevation(elevation) {
  if (!game.user?.isGM) {
    return ui.notifications.warn(
      "Only a GM can configure light elevations."
    );
  }

  const controlledLights =
    canvas?.lighting?.controlled ?? [];

  if (!controlledLights.length) {
    return ui.notifications.warn(
      "Select one or more ambient lights first."
    );
  }

  const numericElevation =
    finiteNumberOr(elevation, 0);

  const updates = controlledLights.map(light => ({
    _id: light.document.id,
    elevation: numericElevation
  }));

  await canvas.scene.updateEmbeddedDocuments(
    "AmbientLight",
    updates
  );

  for (const light of controlledLights) {
    try {
      light.initializeLightSource?.();
    } catch (error) {
      console.warn(
        `${MODULE_ID} | Could not directly reinitialize a selected light.`,
        error
      );
    }
  }

  refreshElevationVision();

  ui.notifications.info(
    `Updated elevation for ${updates.length} light source(s).`
  );
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
  installAmbientLightRadiusWrapper();
});

Hooks.once("ready", () => {
  game.lancerElevationLOS = {
    refresh: refreshElevationVision,
    getWallRange: wallElevationRange,
    setWallRange,
    setSelectedWallRange,
    setAmbientLightElevation,
    setSelectedLightElevation,
    horizontalRadiusAtGround
  };

  refreshElevationVision();
});

Hooks.on(
  "renderWallConfig",
  injectWallElevationFields
);

Hooks.on(
  "renderAmbientLightConfig",
  injectAmbientLightElevationField
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
  "updateAmbientLight",
  (lightDocument, changes) => {
    const relevantChange =
      Object.prototype.hasOwnProperty.call(
        changes,
        "elevation"
      ) ||
      Object.prototype.hasOwnProperty.call(
        changes,
        "x"
      ) ||
      Object.prototype.hasOwnProperty.call(
        changes,
        "y"
      ) ||
      Object.prototype.hasOwnProperty.call(
        changes,
        "walls"
      ) ||
      Object.prototype.hasOwnProperty.call(
        changes,
        "config"
      );

    if (relevantChange) {
      try {
        lightDocument.object?.initializeLightSource?.();
      } catch (error) {
        console.warn(
          `${MODULE_ID} | Could not directly reinitialize the light source.`,
          error
        );
      }

      refreshElevationVision();
    }
  }
);

Hooks.on(
  "createAmbientLight",
  lightDocument => {
    try {
      lightDocument.object?.initializeLightSource?.();
    } catch {
      // The placeable may not be fully drawn yet.
    }

    refreshElevationVision();
  }
);

Hooks.on(
  "deleteAmbientLight",
  refreshElevationVision
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
