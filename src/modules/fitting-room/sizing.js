import { BODY_TYPES, FIT_PREFERENCES } from './catalog.js';
import { BadRequestError } from './errors.js';
import { getSizeChart, resolveGroup } from './repository.js';

const BODY_TYPE_CHEST_ADJUSTMENT = { slim: -3, athletic: 2, regular: 0, broad: 5 };
const BODY_TYPE_WAIST_ADJUSTMENT = { slim: -4, athletic: -2, regular: 0, broad: 4 };
/** Ease the shopper wants on top of their body chest measurement, in cm. */
const FIT_PREFERENCE_EASE = { fitted: -3, regular: 0, loose: 5 };
/** Ease built into each cut, in cm — a slim block needs a touch more body room. */
const FIT_BLOCK_EASE = { slim: -2, tailored: 0, relaxed: 3, oversized: 6 };

/**
 * The numbers behind the recommendation, exported so another surface (the demo
 * storefront, a size guide, an A/B test) can reuse them instead of copying them.
 */
export const SIZING_CONSTANTS = {
  bodyTypeChestAdjustment: BODY_TYPE_CHEST_ADJUSTMENT,
  bodyTypeWaistAdjustment: BODY_TYPE_WAIST_ADJUSTMENT,
  fitPreferenceEase: FIT_PREFERENCE_EASE,
  fitBlockEase: FIT_BLOCK_EASE,
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const article = (word) => (/^[aeiou]/i.test(word) ? 'an' : 'a');
const round1 = (value) => Math.round(value * 10) / 10;

/** How far a measurement sits outside a [min, max] range. 0 means it fits. */
const distanceOutside = (value, [min, max]) => {
  if (value < min) return min - value;
  if (value > max) return value - max;
  return 0;
};

/** 0 at the middle of the range, 1 at either edge — used to break ties. */
const offCentre = (value, [min, max]) => {
  const middle = (min + max) / 2;
  const halfWidth = (max - min) / 2 || 1;
  return Math.min(1, Math.abs(value - middle) / halfWidth);
};

/**
 * Estimate the body measurements we were not given, from height and weight.
 * The coefficients come from the shop's own returns data and are intentionally
 * conservative: a wrong estimate should read one size, never two.
 */
export const estimateMeasurements = ({ heightCm, weightKg, bodyType = 'regular' }) => {
  const chest = 52 + 0.62 * weightKg - 0.25 * (heightCm - 178) + (BODY_TYPE_CHEST_ADJUSTMENT[bodyType] ?? 0);
  const waist = chest - 12 + (BODY_TYPE_WAIST_ADJUSTMENT[bodyType] ?? 0);
  const neck = 0.24 * chest + 13.5;
  return { chest: round1(chest), waist: round1(waist), neck: round1(neck) };
};

const assertProfile = (profile) => {
  const issues = [];
  const heightCm = Number(profile?.heightCm);
  const weightKg = Number(profile?.weightKg);

  if (!Number.isFinite(heightCm) || heightCm < 120 || heightCm > 220) {
    issues.push({ code: 'invalid_height', field: 'heightCm', message: 'Height must be between 120 and 220 cm.' });
  }
  if (!Number.isFinite(weightKg) || weightKg < 35 || weightKg > 200) {
    issues.push({ code: 'invalid_weight', field: 'weightKg', message: 'Weight must be between 35 and 200 kg.' });
  }
  if (profile?.bodyType && !BODY_TYPES.includes(profile.bodyType)) {
    issues.push({ code: 'invalid_body_type', field: 'bodyType', message: `Body type must be one of: ${BODY_TYPES.join(', ')}.` });
  }
  if (profile?.fitPreference && !FIT_PREFERENCES.includes(profile.fitPreference)) {
    issues.push({
      code: 'invalid_fit_preference',
      field: 'fitPreference',
      message: `Fit preference must be one of: ${FIT_PREFERENCES.join(', ')}.`,
    });
  }
  if (issues.length > 0) throw new BadRequestError('The body profile is not valid.', issues);

  return { heightCm, weightKg };
};

/**
 * Recommend a stock size for a body profile, and say how sure we are.
 *
 * @param {object} product
 * @param {{heightCm: number, weightKg: number, chestCm?: number, waistCm?: number, neckCm?: number,
 *          bodyType?: string, fitPreference?: string, fit?: string}} profile
 */
export const recommendSize = (product, profile) => {
  const { heightCm, weightKg } = assertProfile(profile);
  const bodyType = profile.bodyType ?? 'regular';
  const fitPreference = profile.fitPreference ?? 'regular';

  const chart = getSizeChart(product.fittingRoom.sizeChartId);
  const sizeGroup = resolveGroup(product, 'size');
  const offeredSizes = new Set(sizeGroup ? sizeGroup.values.map((value) => value.id) : []);
  const rows = chart.sizes.filter((row) => offeredSizes.size === 0 || offeredSizes.has(row.size));

  if (rows.length === 0) throw new BadRequestError('This product has no stock sizes to recommend.');

  const estimated = estimateMeasurements({ heightCm, weightKg, bodyType });
  const measuredChest = Number.isFinite(Number(profile.chestCm)) ? Number(profile.chestCm) : null;
  const measuredWaist = Number.isFinite(Number(profile.waistCm)) ? Number(profile.waistCm) : null;
  const measuredNeck = Number.isFinite(Number(profile.neckCm)) ? Number(profile.neckCm) : null;

  const body = {
    chest: measuredChest ?? estimated.chest,
    waist: measuredWaist ?? estimated.waist,
    neck: measuredNeck ?? estimated.neck,
  };

  const ease = (FIT_PREFERENCE_EASE[fitPreference] ?? 0) + (FIT_BLOCK_EASE[profile.fit] ?? 0);
  const effectiveChest = body.chest + ease;

  const scored = rows
    .map((row) => {
      const chestMiss = distanceOutside(effectiveChest, row.chest);
      const waistMiss = row.waist ? distanceOutside(body.waist, row.waist) : 0;
      const neckMiss = row.neck ? distanceOutside(body.neck, row.neck) : 0;
      const heightMiss = row.height ? distanceOutside(heightCm, row.height) : 0;

      const score =
        chestMiss * 3 + neckMiss * 2 + waistMiss * 1 + heightMiss * 0.15 + offCentre(effectiveChest, row.chest) * 0.5;

      return { size: row.size, row, score, chestMiss, neckMiss, waistMiss };
    })
    .sort((a, b) => a.score - b.score);

  const [best, runnerUp] = scored;
  const gap = runnerUp ? runnerUp.score - best.score : 5;

  const chartIndexOf = (size) => rows.findIndex((row) => row.size === size);
  const bestChartIndex = chartIndexOf(best.size);
  const neckBest = [...scored].sort((a, b) => a.neckMiss - b.neckMiss || a.score - b.score)[0];
  const neckOffset = Math.abs(chartIndexOf(neckBest.size) - bestChartIndex);

  let confidence = measuredChest ? 0.9 : 0.72;
  if (gap < 1.5) confidence -= 0.2;
  if (best.chestMiss > 0) confidence -= 0.25;
  if (neckOffset >= 2) confidence -= 0.15;
  confidence = round1(clamp(confidence, 0.25, 0.97) * 100) / 100;

  const rationale = [
    measuredChest
      ? `Matched on your chest measurement of ${body.chest} cm.`
      : `Estimated a chest of ${body.chest} cm from ${heightCm} cm / ${weightKg} kg and ${article(bodyType)} ${bodyType} build.`,
    ease !== 0
      ? `Added ${ease > 0 ? '+' : ''}${ease} cm of ease for a ${fitPreference} fit${profile.fit ? ` on the ${profile.fit} block` : ''}.`
      : 'Used the standard ease for this cut.',
    `Size ${best.size.toUpperCase()} covers ${best.row.chest[0]}–${best.row.chest[1]} cm chest.`,
  ];
  if (best.chestMiss > 0) {
    rationale.push(`Your chest sits ${round1(best.chestMiss)} cm outside every stock size — made to measure will fit better.`);
  }
  if (neckOffset >= 2) {
    rationale.push('Your neck and chest point at different sizes, which usually means a made-to-measure collar.');
  }

  const alternates = scored
    .slice(1, 3)
    .map((entry) => ({
      size: entry.size,
      reason:
        entry.score < best.score + 1.5
          ? 'Nearly as good a match — take it if you prefer a different amount of room.'
          : chartIndexOf(entry.size) > bestChartIndex
            ? 'Size up for more room through the chest.'
            : 'Size down for a closer fit.',
    }));

  const madeToMeasureSuggested =
    Boolean(product.fittingRoom.madeToMeasure?.enabled) && (confidence < 0.6 || best.chestMiss > 0 || neckOffset >= 2);

  return {
    recommendedSize: best.size,
    confidence,
    alternates,
    body: { ...body, estimated: { chest: measuredChest === null, waist: measuredWaist === null, neck: measuredNeck === null } },
    ease,
    sizeChartRow: best.row,
    rationale,
    madeToMeasureSuggested,
  };
};

export default recommendSize;
