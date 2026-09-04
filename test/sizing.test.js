import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestError } from '../src/modules/fitting-room/errors.js';
import { getProductBySlug } from '../src/modules/fitting-room/repository.js';
import { estimateMeasurements, recommendSize } from '../src/modules/fitting-room/sizing.js';

const product = getProductBySlug('beige-linen-shirt');

describe('estimateMeasurements', () => {
  it('estimates a plausible chest for an average build', () => {
    const { chest, waist, neck } = estimateMeasurements({ heightCm: 178, weightKg: 75 });
    assert.ok(chest > 95 && chest < 103, `chest was ${chest}`);
    assert.equal(waist, Math.round((chest - 12) * 10) / 10);
    assert.ok(neck > 36 && neck < 40, `neck was ${neck}`);
  });

  it('gives a taller person of the same weight a smaller chest', () => {
    const short = estimateMeasurements({ heightCm: 165, weightKg: 75 });
    const tall = estimateMeasurements({ heightCm: 195, weightKg: 75 });
    assert.ok(tall.chest < short.chest);
  });

  it('widens the chest for a broad build and narrows it for a slim one', () => {
    const slim = estimateMeasurements({ heightCm: 178, weightKg: 75, bodyType: 'slim' });
    const broad = estimateMeasurements({ heightCm: 178, weightKg: 75, bodyType: 'broad' });
    assert.ok(broad.chest - slim.chest === 8);
  });
});

describe('recommendSize', () => {
  it('recommends a middle size for an average body and explains why', () => {
    const result = recommendSize(product, { heightCm: 178, weightKg: 75 });
    assert.equal(result.recommendedSize, 'm');
    assert.ok(result.rationale.length >= 3);
    assert.ok(result.alternates.length > 0);
  });

  it('is more confident with a measured chest than with an estimate', () => {
    const estimated = recommendSize(product, { heightCm: 180, weightKg: 78 });
    const measured = recommendSize(product, { heightCm: 180, weightKg: 78, chestCm: 101 });
    assert.ok(measured.confidence > estimated.confidence);
    assert.equal(measured.body.estimated.chest, false);
  });

  it('sizes up for a loose fit preference', () => {
    const fitted = recommendSize(product, { heightCm: 180, weightKg: 82, fitPreference: 'fitted' });
    const loose = recommendSize(product, { heightCm: 180, weightKg: 82, fitPreference: 'loose' });
    const order = ['xs', 's', 'm', 'l', 'xl', 'xxl'];
    assert.ok(order.indexOf(loose.recommendedSize) > order.indexOf(fitted.recommendedSize));
    assert.ok(loose.ease > fitted.ease);
  });

  it('suggests made to measure when the body falls outside the chart', () => {
    const result = recommendSize(product, { heightCm: 180, weightKg: 145, bodyType: 'broad' });
    assert.equal(result.recommendedSize, 'xxl');
    assert.equal(result.madeToMeasureSuggested, true);
    assert.ok(result.confidence < 0.6);
  });

  it('suggests made to measure when the neck and chest disagree', () => {
    const result = recommendSize(product, { heightCm: 178, weightKg: 68, chestCm: 93, neckCm: 44 });
    assert.equal(result.madeToMeasureSuggested, true);
  });

  it('describes each alternate in the right direction', () => {
    const result = recommendSize(product, { heightCm: 183, weightKg: 84, bodyType: 'athletic' });
    const order = ['xs', 's', 'm', 'l', 'xl', 'xxl'];
    for (const alternate of result.alternates) {
      if (alternate.reason.startsWith('Size up')) {
        assert.ok(order.indexOf(alternate.size) > order.indexOf(result.recommendedSize), `${alternate.size} is not above ${result.recommendedSize}`);
      } else if (alternate.reason.startsWith('Size down')) {
        assert.ok(order.indexOf(alternate.size) < order.indexOf(result.recommendedSize), `${alternate.size} is not below ${result.recommendedSize}`);
      }
    }
  });

  it('only recommends sizes the product actually sells', () => {
    const result = recommendSize(product, { heightCm: 170, weightKg: 60 });
    const offered = ['xs', 's', 'm', 'l', 'xl', 'xxl'];
    assert.ok(offered.includes(result.recommendedSize));
    assert.ok(result.alternates.every((alternate) => offered.includes(alternate.size)));
  });

  it('rejects an implausible body profile', () => {
    assert.throws(() => recommendSize(product, { heightCm: 40, weightKg: 75 }), BadRequestError);
    assert.throws(() => recommendSize(product, { heightCm: 178, weightKg: 75, bodyType: 'triangular' }), BadRequestError);
  });

  it('reports which measurements were estimated', () => {
    const result = recommendSize(product, { heightCm: 178, weightKg: 75, chestCm: 100 });
    assert.deepEqual(result.body.estimated, { chest: false, waist: true, neck: true });
  });
});
