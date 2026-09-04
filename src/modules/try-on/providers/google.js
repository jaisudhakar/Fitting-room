import { ProviderError } from '../errors.js';

/**
 * Google Generative Language image provider.
 *
 * The shopper brings their own key. It arrives per request, is used once and is
 * never written to a store or a log line — the job only remembers which
 * provider ran.
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Google's wording is unhelpful in the one case shoppers actually hit, so translate. */
const translate = (status, body) => {
  const reason = body?.error?.status ?? '';
  const detail = body?.error?.message ?? '';

  if (status === 400 && /api[- ]?key/i.test(detail)) {
    return new ProviderError('Google refused that key. Check that it is correct and that billing is enabled for it.', {
      status: 401,
      code: 'invalid_api_key',
    });
  }
  if (status === 401 || status === 403 || reason === 'PERMISSION_DENIED') {
    return new ProviderError('Google refused that key. Check that it is correct and that billing is enabled for it.', {
      status: 401,
      code: 'invalid_api_key',
    });
  }
  if (status === 429 || reason === 'RESOURCE_EXHAUSTED') {
    return new ProviderError('Google is rate-limiting this key. Wait a moment and draw the look again.', {
      status: 429,
      code: 'rate_limited',
      retryable: true,
    });
  }
  if (status === 404) {
    return new ProviderError(`Google does not offer that image model to this key.`, { status: 502, code: 'model_unavailable' });
  }
  if (status >= 500 || reason === 'UNAVAILABLE') {
    return new ProviderError('Google could not draw the look just now. Try again in a minute.', {
      status: 502,
      code: 'provider_unavailable',
      retryable: true,
    });
  }
  return new ProviderError(detail || 'Google could not draw the look.', { status: 502, code: 'provider_error' });
};

/**
 * @param {{apiKey: string, model?: string, fetchImpl?: typeof fetch, timeoutMs?: number}} options
 */
export const createGoogleProvider = ({ apiKey, model = 'gemini-2.5-flash-image', fetchImpl = fetch, timeoutMs = 90000 } = {}) => ({
  id: 'google',
  model,

  /**
   * @param {{prompt: string}} request
   * @returns {Promise<{mimeType: string, data: string, model: string}>} base64 image
   */
  async draw({ prompt }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetchImpl(`${ENDPOINT}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['IMAGE'] },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new ProviderError(
        error.name === 'AbortError'
          ? 'Google took too long to draw the look. Try again.'
          : 'Could not reach Google from here. Check the network and try again.',
        { status: 504, code: error.name === 'AbortError' ? 'provider_timeout' : 'provider_unreachable', retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }

    const body = await response.json().catch(() => null);
    if (!response.ok) throw translate(response.status, body);

    const parts = body?.candidates?.[0]?.content?.parts ?? [];
    const image = parts.find((part) => part.inlineData?.data ?? part.inline_data?.data);
    const inline = image?.inlineData ?? image?.inline_data;

    if (!inline?.data) {
      const refusal = parts.find((part) => part.text)?.text;
      throw new ProviderError(
        refusal ? `Google returned words instead of a picture: ${refusal.slice(0, 160)}` : 'Google returned no image for that look.',
        { status: 502, code: 'no_image_returned', retryable: true },
      );
    }

    return { mimeType: inline.mimeType ?? inline.mime_type ?? 'image/png', data: inline.data, model };
  },
});

export default createGoogleProvider;
