/**
 * End-to-end walk through the fitting room, without an HTTP server.
 * Run it with: node examples/fitting-room-flow.js
 */
import { fittingRoomService as service, recommendSize, getProductBySlug } from '../src/index.js';

const slug = 'beige-linen-shirt';
const line = (label) => console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`);

line('1. Open the fitting room');
const room = service.getFittingRoom(slug);
console.log(`${room.product.title} — from ${room.product.formattedBasePrice}`);
console.log('Steps:', room.steps.map((step) => step.label).join(' → '));

line('2. Recommend a size from a body profile');
const recommendation = recommendSize(getProductBySlug(slug), {
  heightCm: 183,
  weightKg: 84,
  bodyType: 'athletic',
  fitPreference: 'regular',
});
console.log(`Recommended ${recommendation.recommendedSize.toUpperCase()} (confidence ${recommendation.confidence})`);
recommendation.rationale.forEach((reason) => console.log(`  • ${reason}`));

line('3. Start a draft and customise it');
const draft = service.startSession(slug, { options: { size: recommendation.recommendedSize } });
const customised = service.updateSession(draft.session.id, {
  options: { fit: 'relaxed', fabric: 'stone-washed-linen', collar: 'cutaway', cuff: 'french', pocket: 'double-patch', buttons: 'mother-of-pearl', hem: 'straight' },
  monogram: { text: 'jd', position: 'cuff-left', font: 'script', thread: 'navy' },
  quantity: 1,
});
customised.summary.forEach((item) => console.log(`  ${item.label.padEnd(14)} ${item.value}`));
console.log(`  Ready to add: ${customised.readyToAdd}`);

line('4. Price breakdown');
customised.price.lines.forEach((item) => console.log(`  ${item.label.padEnd(38)} ${item.formattedAmount}`));
console.log(`  ${'Total (incl. VAT)'.padEnd(38)} ${customised.price.formatted.total}`);
console.log(`  Ships in ${customised.price.leadTimeDays} days (around ${customised.price.estimatedShipDate})`);

line('5. What happens on an impossible make-up');
const broken = service.updateSession(draft.session.id, { options: { sleeve: 'short' } });
broken.validation.issues.forEach((issue) => console.log(`  ✗ ${issue.field}: ${issue.message}`));

line('6. Fix it and add to the basket');
service.updateSession(draft.session.id, { options: { sleeve: 'long', cuff: 'french' } });
const { cartLine } = service.completeSession(draft.session.id);
console.log(`  Cart line ${cartLine.variantKey} — ${cartLine.quantity} × ${cartLine.formatted.unitPrice} = ${cartLine.formatted.total}`);
