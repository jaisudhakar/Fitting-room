import config from '../../config/index.js';
import {
  MEASUREMENT_FIELDS,
  MONOGRAM_FONTS,
  MONOGRAM_POSITIONS,
  MONOGRAM_TEXT_PATTERN,
  MONOGRAM_THREADS,
  OPTION_RULES,
  getMonogramPosition,
} from './catalog.js';
import { resolveGroups } from './repository.js';

const issue = (code, field, message, meta = {}) => ({ code, field, message, ...meta });

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Coerce whatever the storefront posted into the shape the rest of the module
 * expects: known keys only, trimmed strings, numeric measurements.
 *
 * @param {object} rawSelection
 * @returns {{options: Record<string,string>, measurements: Record<string,number>|null, monogram: object|null, quantity: number}}
 */
export const normalizeSelection = (rawSelection = {}) => {
  const source = isPlainObject(rawSelection) ? rawSelection : {};

  const options = {};
  if (isPlainObject(source.options)) {
    for (const [groupId, valueId] of Object.entries(source.options)) {
      if (valueId === null || valueId === undefined || valueId === '') continue;
      options[String(groupId)] = String(valueId).trim();
    }
  }

  let measurements = null;
  if (isPlainObject(source.measurements)) {
    measurements = {};
    for (const [fieldId, value] of Object.entries(source.measurements)) {
      if (value === null || value === undefined || value === '') continue;
      const parsed = Number(value);
      measurements[String(fieldId)] = Number.isFinite(parsed) ? parsed : value;
    }
  }

  let monogram = null;
  if (isPlainObject(source.monogram)) {
    const enabled = source.monogram.enabled !== false;
    monogram = enabled
      ? {
          enabled: true,
          text: String(source.monogram.text ?? '').trim().toUpperCase(),
          position: String(source.monogram.position ?? '').trim(),
          font: String(source.monogram.font ?? MONOGRAM_FONTS[0].id).trim(),
          thread: String(source.monogram.thread ?? MONOGRAM_THREADS[0].id).trim(),
        }
      : null;
  }

  const parsedQuantity = Number.parseInt(source.quantity ?? 1, 10);
  const quantity = Number.isFinite(parsedQuantity) ? parsedQuantity : 1;

  return { options, measurements, monogram, quantity };
};

const validateOptions = (product, selection, issues) => {
  const groups = resolveGroups(product);
  const groupsById = new Map(groups.map((group) => [group.id, group]));

  for (const [groupId, valueId] of Object.entries(selection.options)) {
    const group = groupsById.get(groupId);
    if (!group) {
      issues.push(issue('unknown_option_group', `options.${groupId}`, `"${groupId}" is not customisable on this product.`));
      continue;
    }
    if (!group.values.some((value) => value.id === valueId)) {
      issues.push(
        issue('invalid_option_value', `options.${groupId}`, `"${valueId}" is not available for ${group.label.toLowerCase()}.`, {
          allowed: group.values.map((value) => value.id),
        }),
      );
    }
  }

  for (const group of groups) {
    if (group.required && !selection.options[group.id]) {
      issues.push(issue('missing_option', `options.${group.id}`, `${group.label} is required.`));
    }
  }
};

const validateRules = (product, selection, issues) => {
  const availableGroups = new Set(resolveGroups(product).map((group) => group.id));

  for (const rule of OPTION_RULES) {
    if (!availableGroups.has(rule.when.group) || !availableGroups.has(rule.require.group)) continue;

    const actual = selection.options[rule.when.group];
    if (!rule.when.valueIn.includes(actual)) continue;

    const required = selection.options[rule.require.group];
    if (!rule.require.valueIn.includes(required)) {
      issues.push(
        issue('rule_violation', `options.${rule.require.group}`, rule.message, {
          rule: rule.id,
          allowed: rule.require.valueIn,
        }),
      );
    }
  }
};

const validateMeasurements = (product, selection, issues, warnings) => {
  const isMadeToMeasure = selection.options.size === 'made-to-measure';

  if (!isMadeToMeasure) {
    if (selection.measurements && Object.keys(selection.measurements).length > 0) {
      warnings.push(
        issue('measurements_ignored', 'measurements', 'Measurements are only used with the made-to-measure size.'),
      );
    }
    return;
  }

  if (!product.fittingRoom.madeToMeasure?.enabled) {
    issues.push(issue('made_to_measure_unavailable', 'options.size', 'Made to measure is not offered on this product.'));
    return;
  }

  const measurements = selection.measurements ?? {};
  for (const field of MEASUREMENT_FIELDS) {
    const value = measurements[field.id];

    if (value === undefined) {
      if (field.required) {
        issues.push(issue('missing_measurement', `measurements.${field.id}`, `${field.label} is required for made to measure.`));
      }
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push(issue('invalid_measurement', `measurements.${field.id}`, `${field.label} must be a number in ${field.unit}.`));
      continue;
    }
    if (value < field.min || value > field.max) {
      issues.push(
        issue(
          'measurement_out_of_range',
          `measurements.${field.id}`,
          `${field.label} must be between ${field.min} and ${field.max} ${field.unit}.`,
          { min: field.min, max: field.max },
        ),
      );
    }
  }

  for (const fieldId of Object.keys(measurements)) {
    if (!MEASUREMENT_FIELDS.some((field) => field.id === fieldId)) {
      issues.push(issue('unknown_measurement', `measurements.${fieldId}`, `"${fieldId}" is not a measurement we take.`));
    }
  }

  const { chest, waist } = measurements;
  if (typeof chest === 'number' && typeof waist === 'number' && waist > chest + 10) {
    warnings.push(
      issue(
        'measurement_unusual',
        'measurements.waist',
        'The waist is much larger than the chest — our tailor will call to confirm before cutting.',
      ),
    );
  }
};

const validateMonogram = (product, selection, issues) => {
  const { monogram } = selection;
  if (!monogram) return;

  if (!product.fittingRoom.monogram?.enabled) {
    issues.push(issue('monogram_unavailable', 'monogram', 'This product cannot be monogrammed.'));
    return;
  }

  if (!MONOGRAM_TEXT_PATTERN.test(monogram.text)) {
    issues.push(issue('invalid_monogram_text', 'monogram.text', 'Use one to four letters (A–Z).'));
  }

  const position = getMonogramPosition(monogram.position);
  if (!position) {
    issues.push(
      issue('invalid_monogram_position', 'monogram.position', 'Choose where the monogram goes.', {
        allowed: MONOGRAM_POSITIONS.map((item) => item.id),
      }),
    );
  } else {
    if (position.requiresSleeve && selection.options.sleeve && selection.options.sleeve !== position.requiresSleeve) {
      issues.push(
        issue('invalid_monogram_position', 'monogram.position', `${position.label} is only embroidered on a ${position.requiresSleeve} sleeve.`),
      );
    }
    if (position.forbiddenCollars?.includes(selection.options.collar)) {
      issues.push(
        issue('invalid_monogram_position', 'monogram.position', `${position.label} is not available with that collar.`),
      );
    }
  }

  if (!MONOGRAM_FONTS.some((font) => font.id === monogram.font)) {
    issues.push(
      issue('invalid_monogram_font', 'monogram.font', `"${monogram.font}" is not one of our threads' fonts.`, {
        allowed: MONOGRAM_FONTS.map((font) => font.id),
      }),
    );
  }

  if (!MONOGRAM_THREADS.some((thread) => thread.id === monogram.thread)) {
    issues.push(
      issue('invalid_monogram_thread', 'monogram.thread', `"${monogram.thread}" is not one of our thread colours.`, {
        allowed: MONOGRAM_THREADS.map((thread) => thread.id),
      }),
    );
  }
};

const validateQuantity = (selection, issues) => {
  const { quantity } = selection;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > config.maxQuantity) {
    issues.push(issue('invalid_quantity', 'quantity', `Quantity must be a whole number between 1 and ${config.maxQuantity}.`));
  }
};

/**
 * Validate a normalized selection against one product.
 *
 * @returns {{valid: boolean, issues: object[], warnings: object[]}}
 */
export const validateSelection = (product, selection) => {
  const issues = [];
  const warnings = [];

  validateOptions(product, selection, issues);
  validateRules(product, selection, issues);
  validateMeasurements(product, selection, issues, warnings);
  validateMonogram(product, selection, issues);
  validateQuantity(selection, issues);

  return { valid: issues.length === 0, issues, warnings };
};
