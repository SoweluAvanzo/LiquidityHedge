"use client";

/**
 * Generic model-config form rendered from a JSON Schema (FR-S5):
 * adding a risk model requires NO UI change — the registry's schema
 * drives the controls.
 *
 * Supported subset (with a JSON textarea fallback for anything else):
 *  - string + enum      → select
 *  - number / integer   → number input with min/max
 *  - array of numbers   → comma-separated text input
 *
 * Empty optional fields are OMITTED from the config object (the models
 * apply their own defaults); required fields are marked.
 */

import { useState } from "react";

interface SchemaConfigFormProps {
  schema: Record<string, unknown>;
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  disabled?: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** "blockLength" → "Block length" */
function humanize(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const inputClass = "lh-input";
const selectClass = "lh-select";

export function SchemaConfigForm({
  schema,
  config,
  onChange,
  disabled,
}: SchemaConfigFormProps) {
  // Raw text for comma/JSON fields so partial input isn't destroyed.
  const [rawText, setRawText] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});

  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((r): r is string => typeof r === "string")
      : [],
  );

  const setValue = (name: string, value: unknown) => {
    const next = { ...config };
    if (value === undefined) delete next[name];
    else next[name] = value;
    onChange(next);
  };

  const entries = Object.entries(properties).filter(
    (entry): entry is [string, Record<string, unknown>] => isPlainObject(entry[1]),
  );
  if (entries.length === 0) return null;

  return (
    <div
      style={{
        display: "grid",
        gap: "0.75rem",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 14rem), 1fr))",
      }}
    >
      {entries.map(([name, prop]) => {
        const id = `model-config-${name}`;
        const label = (
          <label htmlFor={id} className="lh-label">
            {humanize(name)}
            {required.has(name) && (
              <span className="lh-label-optional"> (required)</span>
            )}
          </label>
        );
        const description =
          typeof prop.description === "string" ? (
            <p className="lh-help">{prop.description}</p>
          ) : null;
        const error = fieldErrors[name];

        // string + enum → select
        if (prop.type === "string" && Array.isArray(prop.enum)) {
          const current =
            typeof config[name] === "string"
              ? (config[name] as string)
              : typeof prop.default === "string"
                ? prop.default
                : String(prop.enum[0]);
          return (
            <div key={name} className="lh-field">
              {label}
              <select
                id={id}
                value={current}
                disabled={disabled}
                onChange={(e) => setValue(name, e.target.value)}
                className={selectClass}
              >
                {prop.enum.map((option) => (
                  <option key={String(option)} value={String(option)}>
                    {String(option)}
                  </option>
                ))}
              </select>
              {description}
            </div>
          );
        }

        // number / integer → number input with bounds
        if (prop.type === "number" || prop.type === "integer") {
          const min =
            typeof prop.minimum === "number"
              ? prop.minimum
              : typeof prop.exclusiveMinimum === "number"
                ? prop.exclusiveMinimum
                : undefined;
          const max = typeof prop.maximum === "number" ? prop.maximum : undefined;
          const current =
            typeof config[name] === "number" ? String(config[name]) : "";
          const placeholder =
            typeof prop.default === "number" ? `default ${prop.default}` : "";
          return (
            <div key={name} className="lh-field">
              {label}
              <input
                id={id}
                type="number"
                inputMode="decimal"
                value={current}
                min={min}
                max={max}
                step={prop.type === "integer" ? 1 : "any"}
                placeholder={placeholder}
                disabled={disabled}
                onChange={(e) => {
                  const text = e.target.value;
                  if (text === "") return setValue(name, undefined);
                  const parsed = Number(text);
                  if (Number.isFinite(parsed)) setValue(name, parsed);
                }}
                className={`${inputClass} lh-input-mono`}
              />
              {description}
            </div>
          );
        }

        // array of numbers → comma-separated input
        const items = isPlainObject(prop.items) ? prop.items : {};
        if (prop.type === "array" && (items.type === "number" || items.type === "integer")) {
          const current =
            rawText[name] ??
            (Array.isArray(config[name]) ? (config[name] as number[]).join(", ") : "");
          return (
            <div key={name} className="lh-field">
              {label}
              <input
                id={id}
                type="text"
                inputMode="decimal"
                value={current}
                placeholder="comma-separated, e.g. 0.65"
                disabled={disabled}
                spellCheck={false}
                onChange={(e) => {
                  const text = e.target.value;
                  setRawText((prev) => ({ ...prev, [name]: text }));
                  if (text.trim() === "") {
                    setFieldErrors((prev) => ({ ...prev, [name]: null }));
                    return setValue(name, undefined);
                  }
                  const parts = text.split(",").map((p) => Number(p.trim()));
                  if (parts.some((p) => !Number.isFinite(p))) {
                    setFieldErrors((prev) => ({
                      ...prev,
                      [name]: "Enter numbers separated by commas.",
                    }));
                    return;
                  }
                  setFieldErrors((prev) => ({ ...prev, [name]: null }));
                  setValue(name, parts);
                }}
                className={`${inputClass} lh-input-mono`}
                aria-invalid={!!error}
              />
              {error && (
                <p className="lh-error-text" role="alert">
                  {error}
                </p>
              )}
              {description}
            </div>
          );
        }

        // Unknown shape → JSON textarea fallback
        const jsonCurrent =
          rawText[name] ??
          (config[name] !== undefined ? JSON.stringify(config[name]) : "");
        return (
          <div key={name} className="lh-field" style={{ gridColumn: "1 / -1" }}>
            {label}
            <textarea
              id={id}
              rows={2}
              value={jsonCurrent}
              placeholder="JSON value"
              disabled={disabled}
              spellCheck={false}
              onChange={(e) => {
                const text = e.target.value;
                setRawText((prev) => ({ ...prev, [name]: text }));
                if (text.trim() === "") {
                  setFieldErrors((prev) => ({ ...prev, [name]: null }));
                  return setValue(name, undefined);
                }
                try {
                  const parsed = JSON.parse(text);
                  setFieldErrors((prev) => ({ ...prev, [name]: null }));
                  setValue(name, parsed);
                } catch {
                  setFieldErrors((prev) => ({ ...prev, [name]: "Invalid JSON." }));
                }
              }}
              className={`lh-textarea lh-input-mono`}
              aria-invalid={!!error}
            />
            {error && (
              <p className="lh-error-text" role="alert">
                {error}
              </p>
            )}
            {description}
          </div>
        );
      })}
    </div>
  );
}
