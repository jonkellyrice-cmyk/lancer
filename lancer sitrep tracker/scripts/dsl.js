/**
 * Lancer Sitrep Tracker — Transparent Presentation DSL
 *
 * Repeated presentation syntax only.
 * The feature file retains all semantic meaning, configuration,
 * composition, conditions, rules, labels, and application behavior.
 */

import {
  escapeHTML
} from "./ui-boilerplate.js";

function contentOf(values) {
  return values
    .flat(Infinity)
    .filter(
      value =>
        value !== false &&
        value !== null &&
        value !== undefined
    )
    .join("");
}

function attributesOf(attributes = {}) {
  const values = Object.entries(attributes)
    .filter(
      ([, value]) =>
        value !== false &&
        value !== null &&
        value !== undefined &&
        value !== ""
    )
    .map(([name, value]) => {
      if (value === true) {
        return name;
      }

      return `${name}="${escapeHTML(value)}"`;
    });

  return values.length
    ? ` ${values.join(" ")}`
    : "";
}

export function element(
  tag,
  attributes = {},
  ...children
) {
  return `<${tag}${attributesOf(attributes)}>${contentOf(children)}</${tag}>`;
}

export function fragment(...children) {
  return contentOf(children);
}

export function each(values, render) {
  return (values ?? [])
    .map(render)
    .join("");
}

export function div(
  className,
  ...children
) {
  return element(
    "div",
    { class: className },
    ...children
  );
}

export function span(
  value,
  className = ""
) {
  return element(
    "span",
    { class: className },
    value
  );
}

export function strong(value) {
  return element(
    "strong",
    {},
    value
  );
}

export function small(value) {
  return element(
    "small",
    {},
    value
  );
}

export function icon(className) {
  return element(
    "i",
    { class: className }
  );
}

export function stat(
  className,
  label,
  value
) {
  return div(
    className,
    span(label),
    strong(value)
  );
}

export function labeledValue(
  className,
  label,
  value
) {
  return div(
    className,
    span(label),
    strong(value)
  );
}

export function statusBlock(
  className,
  value
) {
  return div(
    className,
    value
  );
}

export function option(
  value,
  label,
  selected = false
) {
  return element(
    "option",
    {
      value,
      selected
    },
    escapeHTML(label)
  );
}

export function options(
  values,
  {
    selected = [],
    valueOf = item => item?.id,
    labelOf = item => item?.name ?? item?.id
  } = {}
) {
  const selectedValues = new Set(
    (Array.isArray(selected)
      ? selected
      : [selected]
    ).map(value => String(value ?? ""))
  );

  return each(values, item => {
    const value = String(
      valueOf(item) ?? ""
    );

    return option(
      value,
      labelOf(item),
      selectedValues.has(value)
    );
  });
}

export function chatResult(
  title,
  lines = [],
  className = ""
) {
  return div(
    ["lst-chat-result", className]
      .filter(Boolean)
      .join(" "),
    strong(title),
    each(
      lines,
      line => `<br>${line}`
    )
  );
}
