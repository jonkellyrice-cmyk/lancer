/**
 * Lancer Sitrep Tracker — UI Boilerplate
 *
 * Generic UI mechanics only:
 * - HTML escaping
 * - HUD identity
 * - local position/minimized persistence
 * - viewport clamping
 * - dragging and minimizing
 * - generic HUD mounting and delegated actions
 *
 * This file does not decide what the HUD contains or what any action means.
 */

import { MODULE_ID } from "./kernel.js";

export const HUD_ID = "lancer-sitrep-hud";

const HUD_STATE_KEY =
  `${MODULE_ID}.hudState`;

export function escapeHTML(value) {
  return foundry.utils.escapeHTML(
    String(value ?? "")
  );
}

export function removeHUD() {
  document
    .getElementById(HUD_ID)
    ?.remove();
}

function readHUDState() {
  try {
    const stored =
      localStorage.getItem(
        HUD_STATE_KEY
      );

    if (!stored) return {};

    const parsed = JSON.parse(stored);

    return (
      parsed &&
      typeof parsed === "object"
    )
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

function writeHUDState(
  changes = {}
) {
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

  return sidebar
    ?.getBoundingClientRect?.() ?? null;
}

function clampHUDPosition(
  hud,
  left,
  top
) {
  const margin = 8;

  const maximumLeft = Math.max(
    margin,
    window.innerWidth -
      hud.offsetWidth -
      margin
  );

  const maximumTop = Math.max(
    margin,
    window.innerHeight -
      hud.offsetHeight -
      margin
  );

  return {
    left: Math.min(
      Math.max(
        Number(left) || margin,
        margin
      ),
      maximumLeft
    ),

    top: Math.min(
      Math.max(
        Number(top) || margin,
        margin
      ),
      maximumTop
    )
  };
}

function defaultHUDPosition(hud) {
  const sidebarRect =
    getSidebarRectangle();

  const sidebarLeft =
    sidebarRect?.left ??
    window.innerWidth - 320;

  return clampHUDPosition(
    hud,
    sidebarLeft -
      hud.offsetWidth -
      24,
    80
  );
}

function applyHUDPosition(hud) {
  const savedState = readHUDState();

  const hasSavedLeft =
    Number.isFinite(
      Number(savedState.left)
    );

  const hasSavedTop =
    Number.isFinite(
      Number(savedState.top)
    );

  const position =
    hasSavedLeft && hasSavedTop
      ? clampHUDPosition(
          hud,
          Number(savedState.left),
          Number(savedState.top)
        )
      : defaultHUDPosition(hud);

  hud.style.left =
    `${position.left}px`;

  hud.style.top =
    `${position.top}px`;

  hud.style.right = "auto";

  if (!hasSavedLeft || !hasSavedTop) {
    writeHUDState(position);
  }
}

function updateMinimizeButton(
  hud,
  minimized
) {
  const button = hud.querySelector(
    '[data-action="minimize"]'
  );

  const icon =
    button?.querySelector("i");

  if (!button) return;

  const label = minimized
    ? "Restore Sitrep"
    : "Minimize Sitrep";

  button.title = label;

  button.setAttribute(
    "aria-label",
    label
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

  updateMinimizeButton(
    hud,
    minimized
  );
}

function toggleHUDMinimized(hud) {
  const minimized =
    !hud.classList.contains(
      "lst-minimized"
    );

  hud.classList.toggle(
    "lst-minimized",
    minimized
  );

  updateMinimizeButton(
    hud,
    minimized
  );

  writeHUDState({ minimized });

  requestAnimationFrame(() => {
    const rectangle =
      hud.getBoundingClientRect();

    const position = clampHUDPosition(
      hud,
      rectangle.left,
      rectangle.top
    );

    hud.style.left =
      `${position.left}px`;

    hud.style.top =
      `${position.top}px`;

    writeHUDState(position);
  });
}

function makeHUDDraggable(hud) {
  const handle =
    hud.querySelector(".lst-header");

  if (!handle) return;

  handle.addEventListener(
    "pointerdown",
    event => {
      if (event.button !== 0) return;

      if (event.target.closest("button")) {
        return;
      }

      event.preventDefault();

      const startingRectangle =
        hud.getBoundingClientRect();

      const startingPointerX =
        event.clientX;

      const startingPointerY =
        event.clientY;

      hud.classList.add(
        "lst-dragging"
      );

      handle.setPointerCapture?.(
        event.pointerId
      );

      const handlePointerMove =
        moveEvent => {
          const desiredLeft =
            startingRectangle.left +
            moveEvent.clientX -
            startingPointerX;

          const desiredTop =
            startingRectangle.top +
            moveEvent.clientY -
            startingPointerY;

          const position =
            clampHUDPosition(
              hud,
              desiredLeft,
              desiredTop
            );

          hud.style.left =
            `${position.left}px`;

          hud.style.top =
            `${position.top}px`;

          hud.style.right = "auto";
        };

      const stopDragging =
        endEvent => {
          hud.classList.remove(
            "lst-dragging"
          );

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
            // Pointer capture may already be released.
          }

          const finalRectangle =
            hud.getBoundingClientRect();

          writeHUDState({
            left: Math.round(
              finalRectangle.left
            ),

            top: Math.round(
              finalRectangle.top
            )
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

export function createHUD(
  classNames = []
) {
  removeHUD();

  const hud =
    document.createElement("section");

  hud.id = HUD_ID;

  hud.className = classNames
    .filter(Boolean)
    .join(" ");

  return hud;
}

export function mountHUD(
  hud,
  actionHandlers = {}
) {
  document.body.appendChild(hud);

  applyHUDPosition(hud);
  applyHUDMinimizedState(hud);
  makeHUDDraggable(hud);

  hud.addEventListener(
    "click",
    event => {
      const control =
        event.target.closest?.(
          "[data-action]"
        );

      if (
        !control ||
        !hud.contains(control) ||
        control.disabled
      ) {
        return;
      }

      const action = String(
        control.dataset.action ?? ""
      );

      if (action === "minimize") {
        toggleHUDMinimized(hud);
        return;
      }

      const handler =
        actionHandlers[action];

      if (typeof handler === "function") {
        handler(
          event,
          control,
          hud
        );
      }
    }
  );

  return hud;
}

export function keepHUDOnScreen() {
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

  hud.style.left =
    `${position.left}px`;

  hud.style.top =
    `${position.top}px`;

  hud.style.right = "auto";

  writeHUDState(position);
}
