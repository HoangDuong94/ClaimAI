// srv/m365-mcp/mcp-jsonschema.js
// Minimal JSON Schema to Zod converter tailored to the MCP tool definitions.

function applyCommonMetadata(zodSchema, schema) {
  let result = zodSchema;
  if (schema && typeof schema.description === 'string') {
    result = result.describe(schema.description);
  }
  if (schema && Object.prototype.hasOwnProperty.call(schema, 'default')) {
    result = result.default(schema.default);
  }
  return result;
}

function convertEnum(schema, z) {
  if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
    return null;
  }
  if (schema.enum.every((value) => typeof value === 'string')) {
    return applyCommonMetadata(z.enum([...schema.enum]), schema);
  }
  return applyCommonMetadata(z.union(schema.enum.map((value) => z.literal(value))), schema);
}

function convertArray(schema, z) {
  const itemSchema = schema.items ? jsonSchemaToZod(schema.items, z) : z.any();
  let arraySchema = z.array(itemSchema);
  if (typeof schema.minItems === 'number') {
    arraySchema = arraySchema.min(schema.minItems);
  }
  if (typeof schema.maxItems === 'number') {
    arraySchema = arraySchema.max(schema.maxItems);
  }
  return applyCommonMetadata(arraySchema, schema);
}

function convertObject(schema, z) {
  const properties = schema.properties || {};
  const requiredProps = new Set(schema.required || []);
  const shape = {};

  for (const [key, propertySchema] of Object.entries(properties)) {
    let prop = jsonSchemaToZod(propertySchema, z);
    if (!requiredProps.has(key)) {
      prop = prop.optional();
    }
    shape[key] = prop;
  }

  let objectSchema = z.object(shape);
  if (schema.additionalProperties) {
    const additional = jsonSchemaToZod(schema.additionalProperties, z);
    objectSchema = objectSchema.catchall(additional);
  } else {
    objectSchema = objectSchema.strict();
  }

  if (schema.minProperties) {
    objectSchema = objectSchema.min(schema.minProperties);
  }
  if (schema.maxProperties) {
    objectSchema = objectSchema.max(schema.maxProperties);
  }

  return applyCommonMetadata(objectSchema, schema);
}

export function jsonSchemaToZod(schema, z) {
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
      if (schema.minLength) {
        stringSchema = stringSchema.min(schema.minLength);
      }
      if (schema.maxLength) {
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
