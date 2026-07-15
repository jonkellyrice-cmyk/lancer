/**
 * Lancer Sitrep Tracker — System Layer
 *
 * Lowest-level accessors, selectors, predicates, and transforms only.
 * This file contains no sitrep configuration, composition, rendering,
 * encounter resolution, or lifecycle wiring.
 */

export const MODULE_ID = "lancer-sitrep-tracker";
export const FLAG_KEY = "sitrep";

export function activeCombat() {
  return game.combat ?? game.combats?.active ?? null;
}

export function getSitrep(
  combat = activeCombat()
) {
  return combat?.getFlag(
    MODULE_ID,
    FLAG_KEY
  ) ?? null;
}

export function isPrimaryGM() {
  if (!game.user?.isGM) return false;

  const activeGMs = game.users.filter(
    user => user.active && user.isGM
  );

  return (
    !activeGMs.length ||
    activeGMs[0].id === game.user.id
  );
}

export function tokenDisposition(
  tokenDocument
) {
  return Number(
    tokenDocument?.disposition ?? 0
  );
}

export function factionOf(
  tokenDocument
) {
  const disposition =
    tokenDisposition(tokenDocument);

  const friendly = Number(
    CONST.TOKEN_DISPOSITIONS?.FRIENDLY ?? 1
  );

  const hostile = Number(
    CONST.TOKEN_DISPOSITIONS?.HOSTILE ?? -1
  );

  if (disposition === friendly) {
    return "friendly";
  }

  if (disposition === hostile) {
    return "hostile";
  }

  return "neutral";
}

export function combatantIsDefeated(
  combatant
) {
  if (
    typeof combatant?.isDefeated ===
    "boolean"
  ) {
    return combatant.isDefeated;
  }

  if (combatant?.defeated === true) {
    return true;
  }

  const defeatedId =
    CONFIG.specialStatusEffects?.DEFEATED;

  return Boolean(
    defeatedId &&
    combatant?.actor?.statuses?.has?.(
      defeatedId
    )
  );
}

export function regionFor(
  combat,
  sitrep
) {
  const scene =
    combat?.scene ?? canvas.scene;

  return scene?.regions?.get(
    sitrep?.regionId
  ) ?? null;
}

export function controlRegionsFor(
  combat,
  sitrep
) {
  const scene =
    combat?.scene ?? canvas.scene;

  const ids = Array.isArray(
    sitrep?.controlRegionIds
  )
    ? sitrep.controlRegionIds
    : [];

  return ids
    .map(
      id =>
        scene?.regions?.get(id) ?? null
    )
    .filter(Boolean);
}

export function controllerFromCounts(
  friendly,
  hostile
) {
  if (friendly > hostile) {
    return "friendly";
  }

  if (hostile > friendly) {
    return "hostile";
  }

  return "contested";
}

export function combatantById(
  combat,
  combatantId
) {
  return combat?.combatants?.get(
    combatantId
  ) ?? null;
}

export function tokenBoundsInGridSpaces(
  tokenDocument
) {
  const gridSize = Number(
    canvas?.grid?.size ??
    canvas?.scene?.grid?.size ??
    100
  );

  const left =
    Number(tokenDocument?.x ?? 0) /
    gridSize;

  const top =
    Number(tokenDocument?.y ?? 0) /
    gridSize;

  const width = Number(
    tokenDocument?.width ?? 1
  );

  const height = Number(
    tokenDocument?.height ?? 1
  );

  return {
    left,
    top,
    right: left + width,
    bottom: top + height
  };
}

export function tokensAreAdjacent(
  firstToken,
  secondToken
) {
  if (!firstToken || !secondToken) {
    return false;
  }

  const first =
    tokenBoundsInGridSpaces(firstToken);

  const second =
    tokenBoundsInGridSpaces(secondToken);

  const horizontalGap = Math.max(
    0,
    Math.max(
      first.left,
      second.left
    ) -
      Math.min(
        first.right,
        second.right
      )
  );

  const verticalGap = Math.max(
    0,
    Math.max(
      first.top,
      second.top
    ) -
      Math.min(
        first.bottom,
        second.bottom
      )
  );

  return (
    horizontalGap <= 0.05 &&
    verticalGap <= 0.05
  );
}

export function tokenInsideRegion(
  tokenDocument,
  region
) {
  if (!tokenDocument || !region) {
    return false;
  }

  try {
    return Boolean(
      tokenDocument.testInsideRegion(region)
    );
  } catch (error) {
    console.warn(
      `${MODULE_ID} | Could not test token in Region`,
      error
    );

    return Boolean(
      tokenDocument.regions?.has?.(
        region.id
      )
    );
  }
}
