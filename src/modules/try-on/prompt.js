import { getMannequin } from './catalog.js';

/**
 * Turn the picks into the instruction the image model receives.
 *
 * The customisation is the whole point: a shopper who chose stone-washed linen,
 * a cutaway collar and a French cuff should see those, not a generic shirt. So
 * every make-up detail the fitting room captured is spelled out here, in the
 * words the atelier uses.
 */

const clause = (pick) => {
  const parts = [];
  const say = (label) => (label ? parts.push(label) : undefined);

  say(pick.details.fit && `${pick.details.fit.toLowerCase()} fit`);
  say(pick.details.fabric && pick.details.fabric.toLowerCase());
  say(pick.details.collar && `${pick.details.collar.toLowerCase()} collar`);
  say(pick.details.sleeve && pick.details.sleeve.toLowerCase());
  say(pick.details.cuff && pick.details.cuff !== 'No cuff (short sleeve)' && `${pick.details.cuff.toLowerCase()}s`);
  say(pick.details.pocket && pick.details.pocket !== 'No pocket' && pick.details.pocket.toLowerCase());
  say(pick.details.buttons && `${pick.details.buttons.toLowerCase()} buttons`);
  say(pick.details.hem && pick.details.hem.toLowerCase());

  const monogram = pick.monogram
    ? `, with the initials ${pick.monogram.text} embroidered in ${pick.monogram.thread.toLowerCase()} thread on the ${pick.monogram.position.toLowerCase()}`
    : '';

  return `${pick.title} — ${parts.join(', ')}${monogram}`;
};

/**
 * @param {{picks: object[], mannequinId: string, notes?: string}} look
 * @returns {string}
 */
export const buildPrompt = ({ picks, mannequinId, notes }) => {
  const mannequin = getMannequin(mannequinId);
  const garments = picks.map((pick, index) => `${index + 1}. ${clause(pick)}`).join('\n');

  return [
    'Photograph a fitting room look for an online clothing shop.',
    '',
    mannequin ? `Setting: ${mannequin.description}` : 'Setting: a featureless light-grey shop mannequin on a soft grey backdrop.',
    '',
    picks.length === 1 ? 'The piece being worn:' : 'The pieces being worn together:',
    garments,
    '',
    'Rules:',
    '- Show every listed detail exactly as described; the fabric colour and weight must read true.',
    '- Natural daylight, soft shadows, no props, no text, no logos, no watermark.',
    '- Full length, the whole garment in frame, sharp focus, plain background.',
    '- No human face or skin: the form is a plain mannequin.',
    notes ? `- ${notes}` : null,
  ]
    .filter((line) => line !== null)
    .join('\n');
};

export default buildPrompt;
