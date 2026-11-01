/**
 * Smaller advertised input schemas.
 *
 * Tool definitions are sent to the model with every request, so each
 * keyword in them costs tokens on every turn. This drops the keywords an
 * agent does not need to write a correct call (length and item limits,
 * `propertyNames`, `$schema`, an empty `additionalProperties`). The server
 * still validates every call against the full schema, so an argument
 * outside a limit is refused with a message that names the limit.
 *
 * Numeric `minimum` / `maximum` stay: they steer timeouts and sizes, where
 * a guessed value would otherwise cost a failed call.
 */

import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';

const DROPPED = new Set(['$schema', 'propertyNames', 'minLength', 'maxLength', 'minItems', 'maxItems']);

/** Keys whose value is a map of names to schemas, where names are not keywords. */
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);

export function compactJsonSchema(node: unknown, inMap = false): unknown {
  if (Array.isArray(node)) return node.map((item) => compactJsonSchema(item));
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (!inMap) {
      if (DROPPED.has(key)) continue;
      // `additionalProperties: {}` allows anything, the same as leaving it out.
      if (key === 'additionalProperties' && value && typeof value === 'object' && Object.keys(value).length === 0) continue;
    }
    out[key] = compactJsonSchema(value, !inMap && SCHEMA_MAPS.has(key));
  }
  return out;
}

/**
 * Wrap a schema so the JSON Schema listed in tools/list is compacted while
 * validation (`~standard.validate`) still runs the original schema.
 */
export function withCompactJsonSchema(schema: StandardSchemaWithJSON): StandardSchemaWithJSON {
  const std = schema['~standard'] as StandardSchemaWithJSON['~standard'];
  if (!std.jsonSchema) return schema;
  const jsonSchema = std.jsonSchema;
  return {
    '~standard': {
      ...std,
      validate: std.validate.bind(std),
      jsonSchema: {
        input: (options) => compactJsonSchema(jsonSchema.input(options)) as Record<string, unknown>,
        output: (options) => compactJsonSchema(jsonSchema.output(options)) as Record<string, unknown>,
      },
    },
  } as StandardSchemaWithJSON;
}
