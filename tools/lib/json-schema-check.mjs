/** draft 2020-12 の本台帳で使うサブセット。未対応の検証語は黙認しない。 */
export function checkSchema(schema, value, location = '$') {
  const errors = [];
  const supported = new Set(['$schema', '$id', 'title', 'description', 'type', 'required', 'properties', 'items', 'enum', 'additionalProperties', 'minimum', 'pattern']);
  for (const key of Object.keys(schema)) {
    if (!supported.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
  }
  const matches = (type) => {
    if (type === 'null') return value === null;
    if (type === 'array') return Array.isArray(value);
    if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    if (type === 'integer') return Number.isInteger(value);
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (['string', 'boolean'].includes(type)) return typeof value === type;
    throw new Error(`Unsupported schema type: ${type}`);
  };
  if (schema.type && ![].concat(schema.type).some(matches)) return [`${location}: type ${schema.type}`];
  if (schema.enum && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) errors.push(`${location}: enum`);
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errors.push(`${location}: minimum ${schema.minimum}`);
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${location}: pattern`);
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errors.push(...checkSchema(schema.items, v, `${location}[${i}]`)));
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(`${location}.${key}: required`);
    for (const [key, v] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) errors.push(...checkSchema(schema.properties[key], v, `${location}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${location}.${key}: additionalProperties`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errors.push(...checkSchema(schema.additionalProperties, v, `${location}.${key}`));
    }
  }
  return errors;
}
