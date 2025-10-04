// srv/m365-mcp/mcp-jsonschema.ts
// Minimal JSON Schema to Zod converter tailored to the MCP tool definitions.

import type { UnknownKeysParam, ZodObject, ZodTypeAny } from 'zod';

type ZodNamespace = typeof import('zod');

export interface JsonSchema {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  enum?: unknown[];
  description?: string;
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: JsonSchema | boolean;
  minProperties?: number;
  maxProperties?: number;
  items?: JsonSchema | JsonSchema[];
  minItems?: number;
  maxItems?: number;
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  anyOf?: JsonSchema[];
}

const hasOwn = Object.prototype.hasOwnProperty;

function applyCommonMetadata(schema: ZodTypeAny, jsonSchema?: JsonSchema | null): ZodTypeAny {
  let result: ZodTypeAny = schema;
  if (jsonSchema?.description) {
    result = result.describe(jsonSchema.description);
  }
  if (jsonSchema && hasOwn.call(jsonSchema, 'default')) {
    result = result.default(jsonSchema.default as unknown) as ZodTypeAny;
  }
  return result;
}

function convertEnum(schema: JsonSchema, z: ZodNamespace): ZodTypeAny | null {
  if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
    return null;
  }
  if (schema.enum.every((value) => typeof value === 'string')) {
    const stringValues = schema.enum as string[];
    const [first, ...rest] = stringValues;
    return applyCommonMetadata(z.enum([first, ...rest] as [string, ...string[]]), schema);
  }
  const literals = schema.enum.map((value) => z.literal(value as never)) as ZodTypeAny[];
  if (literals.length === 1) {
    return applyCommonMetadata(literals[0], schema);
  }
  const [firstLiteral, secondLiteral, ...rest] = literals;
  return applyCommonMetadata(z.union([firstLiteral, secondLiteral, ...rest] as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]), schema);
}

function convertArray(schema: JsonSchema, z: ZodNamespace): ZodTypeAny {
  const itemDefinition = Array.isArray(schema.items) ? schema.items[0] : schema.items;
  const itemSchema = itemDefinition ? jsonSchemaToZod(itemDefinition, z) : z.any();
  let arraySchema = z.array(itemSchema);
  if (typeof schema.minItems === 'number') {
    arraySchema = arraySchema.min(schema.minItems);
  }
  if (typeof schema.maxItems === 'number') {
    arraySchema = arraySchema.max(schema.maxItems);
  }
  return applyCommonMetadata(arraySchema, schema);
}

function convertObject(schema: JsonSchema, z: ZodNamespace): ZodTypeAny {
  const properties = schema.properties || {};
  const requiredProps = new Set(schema.required || []);
  const shape: Record<string, ZodTypeAny> = {};

  for (const [key, propertySchema] of Object.entries(properties)) {
    let prop = jsonSchemaToZod(propertySchema, z);
    if (!requiredProps.has(key)) {
      prop = prop.optional();
    }
    shape[key] = prop;
  }

  let objectSchema: ZodObject<Record<string, ZodTypeAny>, UnknownKeysParam, ZodTypeAny> = z.object(shape);
  if (schema.additionalProperties === true) {
    objectSchema = objectSchema.passthrough();
  } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    const additional = jsonSchemaToZod(schema.additionalProperties, z);
    objectSchema = objectSchema.catchall(additional);
  } else {
    objectSchema = objectSchema.strict();
  }

  let resultSchema: ZodTypeAny = objectSchema;

  if (typeof schema.minProperties === 'number' || typeof schema.maxProperties === 'number') {
    const { minProperties, maxProperties } = schema;
    resultSchema = objectSchema.superRefine((data, ctx) => {
      const propertyCount = Object.keys(data).length;
      if (typeof minProperties === 'number' && propertyCount < minProperties) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Expected at least ${minProperties} properties`
        });
      }
      if (typeof maxProperties === 'number' && propertyCount > maxProperties) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Expected at most ${maxProperties} properties`
        });
      }
    });
  }

  return applyCommonMetadata(resultSchema, schema);
}

export function jsonSchemaToZod(schema: JsonSchema | undefined, z: ZodNamespace): ZodTypeAny {
  if (!schema) {
    return z.any();
  }

  if (schema.enum) {
    const enumSchema = convertEnum(schema, z);
    if (enumSchema) {
      return enumSchema;
    }
  }

  switch (schema.type) {
    case 'string': {
      let stringSchema = z.string();
      if (schema.format === 'date-time') {
        stringSchema = stringSchema.regex(/^[^\s]+$/, 'Expected ISO-8601 datetime string');
      }
      if (typeof schema.minLength === 'number') {
        stringSchema = stringSchema.min(schema.minLength);
      }
      if (typeof schema.maxLength === 'number') {
        stringSchema = stringSchema.max(schema.maxLength);
      }
      return applyCommonMetadata(stringSchema, schema);
    }
    case 'number':
    case 'integer': {
      let numberSchema = schema.type === 'integer' ? z.number().int() : z.number();
      if (typeof schema.minimum === 'number') {
        numberSchema = numberSchema.min(schema.minimum);
      }
      if (typeof schema.maximum === 'number') {
        numberSchema = numberSchema.max(schema.maximum);
      }
      return applyCommonMetadata(numberSchema, schema);
    }
    case 'boolean': {
      return applyCommonMetadata(z.boolean(), schema);
    }
    case 'array': {
      return convertArray(schema, z);
    }
    case 'object': {
      return convertObject(schema, z);
    }
    default:
      return applyCommonMetadata(z.any(), schema);
  }
}
