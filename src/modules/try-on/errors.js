import { FittingRoomError } from '../fitting-room/errors.js';

/**
 * A failure that came back from the image provider, already translated into
 * something a shopper can act on. `retryable` tells the UI whether "Draw the
 * look" is worth pressing again.
 */
export class ProviderError extends FittingRoomError {
  constructor(message, { status = 502, code = 'provider_error', retryable = false, provider = 'google' } = {}) {
    super(message, { status, code });
    this.retryable = retryable;
    this.provider = provider;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, retryable: this.retryable, provider: this.provider } };
  }
}

export class MissingKeyError extends ProviderError {
  constructor(message = 'Add your Google API key to draw the look.') {
    super(message, { status: 401, code: 'missing_api_key', retryable: false });
  }
}
