/**
 * The offline provider. It draws nothing — it returns a 1×1 placeholder and the
 * prompt that would have been sent — so the flow can be exercised, and tested,
 * without a key or a network.
 */
const PLACEHOLDER_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export const createPreviewProvider = ({ delayMs = 0 } = {}) => ({
  id: 'preview',
  model: 'preview',

  async draw({ prompt }) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { mimeType: 'image/png', data: PLACEHOLDER_PNG, model: 'preview', prompt };
  },
});

export default createPreviewProvider;
