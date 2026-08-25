/**
 * Adapt a generated JSON Schema to what Codex's `--output-schema` accepts, and
 * undo the adaptation on the way back.
 *
 * Codex forwards the file straight to the model API's structured-output mode,
 * which is stricter than JSON Schema: every object must list *every* property in
 * `required`, must set `additionalProperties: false`, and must carry no
 * validation keywords (`default`, `minItems`, `minLength`, …). A schema that
 * breaks any of those comes back as a 400 before the model is ever called, so
 * the raw `zod-to-json-schema` output cannot be passed through.
 *
 * The adaptation has to preserve one property of the review contract: **silence
 * still buys nothing**. Fields that were optional or carried a default are made
 * *nullable* rather than merely required, so the reviewer can still decline to
 * answer — it writes `null`, `stripNulls` removes the key, and the Zod default
 * applies exactly as it did when the field could be omitted. Forcing a real
 * value would quietly turn `verificationStatus` from "PROVISIONAL unless earned"
 * into "pick one", which is the opposite of what the verification gate exists to
 * enforce.
 */

/** Validation keywords the strict structured-output mode refuses outright. */
const UNSUPPORTED_KEYWORDS = [
  'default',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
  'uniqueItems',
  'multipleOf',
  'patternProperties',
  'additionalItems',
  '$schema',
] as const;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rewrite `schema` into the strict dialect.
 *
 * Descriptions are deliberately kept: they are the only part of the schema that
 * carries reviewer guidance, and they cost nothing at validation time.
 */
export function toStrictJsonSchema(schema: unknown): unknown {
  return convert(schema);
}

function convert(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(convert);
  if (!isObject(node)) return node;

  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if ((UNSUPPORTED_KEYWORDS as readonly string[]).includes(key)) continue;
    out[key] = key === 'properties' || key === 'definitions' || key === '$defs' ? convertMap(value) : convert(value);
  }

  if (!isObject(out.properties)) return out;

  const propertyNames = Object.keys(out.properties);
  const alreadyRequired = new Set(Array.isArray(out.required) ? (out.required as unknown[]).filter((r): r is string => typeof r === 'string') : []);

  for (const name of propertyNames) {
    if (alreadyRequired.has(name)) continue;
    // Optional in the source schema, so it must stay declinable here.
    (out.properties as JsonObject)[name] = makeNullable((out.properties as JsonObject)[name]);
  }

  out.required = propertyNames;
  out.additionalProperties = false;
  return out;
}

function convertMap(value: unknown): unknown {
  if (!isObject(value)) return convert(value);
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(value)) out[key] = convert(child);
  return out;
}

/**
 * Widen a node to also accept `null`.
 *
 * `type: [..., 'null']` is the form the strict mode documents for this, so it is
 * preferred over wrapping in `anyOf` wherever the node has a plain type.
 */
function makeNullable(node: unknown): unknown {
  if (!isObject(node)) return node;
  if (Array.isArray(node.anyOf)) return { ...node, anyOf: [...node.anyOf, { type: 'null' }] };
  if (Array.isArray(node.oneOf)) return { ...node, oneOf: [...node.oneOf, { type: 'null' }] };

  if (typeof node.type === 'string') {
    if (node.type === 'null') return node;
    const widened: JsonObject = { ...node, type: [node.type, 'null'] };
    // An enum constrains the value list independently of `type`, so null has to
    // be admitted there too or the union is unsatisfiable.
    if (Array.isArray(node.enum) && !node.enum.includes(null)) widened.enum = [...node.enum, null];
    return widened;
  }

  if (Array.isArray(node.type)) {
    if (node.type.includes('null')) return node;
    const widened: JsonObject = { ...node, type: [...node.type, 'null'] };
    if (Array.isArray(node.enum) && !node.enum.includes(null)) widened.enum = [...node.enum, null];
    return widened;
  }

  if (Array.isArray(node.enum)) {
    return node.enum.includes(null) ? node : { ...node, enum: [...node.enum, null] };
  }

  return { anyOf: [node, { type: 'null' }] };
}

/**
 * Drop `null`-valued object properties, recursively.
 *
 * This is the inverse of `makeNullable`: the reviewer declined the field, and
 * the Zod schema expresses "declined" as absent, not as null. Nulls *inside*
 * arrays are left alone — position is meaningful there, and no result schema
 * declares a nullable array element.
 */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === null) continue;
    out[key] = stripNulls(child);
  }
  return out;
}
