/**
 * Lancer Sitrep Tracker — Foundry Program Wrapper
 *
 * Mechanical Foundry integration only. The main feature file supplies the
 * public API, hook list, callback meanings, timing, and tracker-button content.
 */

function normalizeRoot(html) {
  return html?.[0] ?? html;
}

function createDebouncedHandler(
  key,
  handler,
  delay
) {
  return (...args) => {
    clearTimeout(globalThis[key]);

    globalThis[key] = setTimeout(
      () => handler(...args),
      delay
    );
  };
}

function installCombatTrackerButton(
  html,
  definition
) {
  const root = normalizeRoot(html);

  if (!root || definition.when?.() === false) {
    return;
  }

  if (
    root.querySelector?.(
      `.${definition.className}`
    )
  ) {
    return;
  }

  const button =
    document.createElement("button");

  button.type = "button";
  button.className =
    definition.className;

  button.innerHTML =
    definition.content;

  button.addEventListener(
    "click",
    definition.onClick
  );

  const target =
    definition.findTarget(root);

  target?.prepend(button);
}

export function installProgram({
  moduleId,
  publicApi,
  ready,
  resize,
  combatTrackerButton,
  hooks
}) {
  Hooks.once("init", () => {
    console.log(
      `${moduleId} | Initializing`
    );
  });

  Hooks.once("ready", () => {
    game.lancerSitrep = publicApi;

    if (resize) {
      const resizeHandler =
        resize.delay
          ? createDebouncedHandler(
              resize.key,
              resize.handler,
              resize.delay
            )
          : resize.handler;

      window.addEventListener(
        "resize",
        resizeHandler
      );
    }

    ready?.();
  });

  for (const definition of hooks) {
    if (definition.kind === "combat-tracker-button") {
      Hooks.on(
        definition.event,
        (app, html) =>
          installCombatTrackerButton(
            html,
            combatTrackerButton
          )
      );

      continue;
    }

    const handler = definition.delay
      ? createDebouncedHandler(
          definition.key,
          definition.handler,
          definition.delay
        )
      : definition.handler;

    Hooks.on(
      definition.event,
      handler
    );
  }
}
