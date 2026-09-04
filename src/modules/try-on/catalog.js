/**
 * The forms a look can be drawn on, and the limits of a try-on session.
 *
 * A mannequin is described in words rather than shipped as a photograph: the
 * image model is asked to build the figure, so a deployment can swap in its own
 * photographed form by adding `imageUrl` to an entry.
 */
export const MANNEQUINS = [
  {
    id: 'atelier-form',
    label: 'Atelier form',
    description: 'A featureless light-grey shop mannequin, full length, standing square to camera on a soft grey backdrop.',
    height: 'tall',
  },
  {
    id: 'seated-form',
    label: 'Seated form',
    description: 'A featureless light-grey mannequin seated on a plain stool, three-quarter view, soft grey backdrop.',
    height: 'tall',
  },
  {
    id: 'flat-lay',
    label: 'Flat lay',
    description: 'No figure: the pieces styled as a flat lay on a linen sheet, shot from directly above in daylight.',
    height: null,
  },
];

export const MAX_PICKS = 6;

export const getMannequin = (id) => MANNEQUINS.find((mannequin) => mannequin.id === id) ?? null;

export const DEFAULT_MANNEQUIN_ID = MANNEQUINS[0].id;
