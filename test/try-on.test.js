import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { BadRequestError, NotFoundError, ValidationError } from '../src/modules/fitting-room/errors.js';
import { InMemorySessionStore, setSessionStore } from '../src/modules/fitting-room/session.js';
import * as fittingRoom from '../src/modules/fitting-room/service.js';
import { MAX_PICKS } from '../src/modules/try-on/catalog.js';
import { MissingKeyError } from '../src/modules/try-on/errors.js';
import { buildPrompt } from '../src/modules/try-on/prompt.js';
import { createGoogleProvider } from '../src/modules/try-on/providers/google.js';
import { InMemoryTryOnStore, setTryOnStore } from '../src/modules/try-on/session.js';
import * as tryOn from '../src/modules/try-on/service.js';

const makeUp = (overrides = {}) => {
  const draft = fittingRoom.startSession('beige-linen-shirt');
  return fittingRoom.updateSession(draft.session.id, overrides).selection;
};

/** A fetch stand-in that answers with one canned Google response. */
const stubFetch = (status, body) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

beforeEach(() => {
  setSessionStore(new InMemorySessionStore());
  setTryOnStore(new InMemoryTryOnStore());
});

describe('buildPrompt', () => {
  it('spells out the make-up the shopper chose', () => {
    const prompt = buildPrompt({
      mannequinId: 'atelier-form',
      picks: [
        {
          title: 'Beige Linen Shirt',
          details: { fit: 'Relaxed', fabric: 'Stone-washed linen 170g', collar: 'Cutaway', sleeve: 'Long sleeve', cuff: 'French cuff', pocket: 'No pocket', buttons: 'Mother of pearl', hem: 'Straight hem' },
          monogram: { text: 'JD', position: 'Left cuff', thread: 'Navy' },
        },
      ],
    });

    assert.match(prompt, /stone-washed linen 170g/);
    assert.match(prompt, /cutaway collar/);
    assert.match(prompt, /initials JD embroidered in navy thread on the left cuff/);
    assert.doesNotMatch(prompt, /No pocket/i, 'an absent detail should not be described');
    assert.match(prompt, /mannequin/);
  });

  it('names every piece when several are worn together', () => {
    const prompt = buildPrompt({
      mannequinId: 'flat-lay',
      picks: [
        { title: 'Beige Linen Shirt', details: { fabric: 'Beige linen 160g' }, monogram: null },
        { title: 'Stone Linen Trousers', details: { fabric: 'Stone-washed linen 170g' }, monogram: null },
      ],
    });
    assert.match(prompt, /pieces being worn together/);
    assert.match(prompt, /1\. Beige Linen Shirt/);
    assert.match(prompt, /2\. Stone Linen Trousers/);
    assert.match(prompt, /flat lay/i);
  });
});

describe('the rail', () => {
  it('hangs a validated make-up, with its price and fabric colour', () => {
    const session = tryOn.startTryOn();
    const result = tryOn.addPick(session.session.id, {
      slug: 'beige-linen-shirt',
      selection: makeUp({ options: { fabric: 'stone-washed-linen' } }),
    });

    assert.equal(result.added, true);
    assert.equal(result.pieces, 1);
    assert.equal(result.pick.title, 'Beige Linen Shirt');
    assert.equal(result.pick.swatch, '#CDBEA4');
    assert.match(result.pick.formattedUnitPrice, /€/);
    assert.equal(result.pick.selection, undefined, 'the raw selection stays server-side');
  });

  it('refuses a make-up that cannot be manufactured', () => {
    const session = tryOn.startTryOn();
    assert.throws(
      () => tryOn.addPick(session.session.id, { slug: 'beige-linen-shirt', selection: makeUp({ options: { sleeve: 'short' } }) }),
      ValidationError,
    );
  });

  it('ignores the same make-up hung twice', () => {
    const session = tryOn.startTryOn();
    const selection = makeUp();
    tryOn.addPick(session.session.id, { slug: 'beige-linen-shirt', selection });
    const again = tryOn.addPick(session.session.id, { slug: 'beige-linen-shirt', selection });
    assert.equal(again.added, false);
    assert.equal(again.pieces, 1);
  });

  it('caps the look at ' + MAX_PICKS + ' pieces', () => {
    const session = tryOn.startTryOn();
    const fabrics = ['beige-linen-160', 'linen-cotton-blend', 'stone-washed-linen', 'garment-dyed-linen', 'belgian-linen-180'];
    for (const fabric of fabrics) tryOn.addPick(session.session.id, { slug: 'beige-linen-shirt', selection: makeUp({ options: { fabric } }) });
    tryOn.addPick(session.session.id, { slug: 'stone-linen-trousers', selection: fittingRoom.startSession('stone-linen-trousers').selection });

    assert.equal(tryOn.getTryOn(session.session.id).pieces, MAX_PICKS);
    assert.throws(
      () => tryOn.addPick(session.session.id, { slug: 'beige-linen-shirt', selection: makeUp({ options: { collar: 'band' } }) }),
      BadRequestError,
    );
  });

  it('takes a piece off the rail and starts over', () => {
    const session = tryOn.startTryOn();
    const added = tryOn.addPick(session.session.id, { slug: 'beige-linen-shirt', selection: makeUp() });
    assert.equal(tryOn.removePick(session.session.id, added.pick.id).pieces, 0);
    assert.throws(() => tryOn.removePick(session.session.id, 'nope'), NotFoundError);

    tryOn.addPick(session.session.id, { slug: 'beige-linen-shirt', selection: makeUp() });
    assert.equal(tryOn.resetTryOn(session.session.id).pieces, 0);
  });
});

describe('drawing the look', () => {
  it('needs a piece on the rail', async () => {
    const session = tryOn.startTryOn();
    await assert.rejects(() => tryOn.drawLook(session.session.id, { provider: 'preview' }), BadRequestError);
  });

  it('needs an API key when Google is the provider', async () => {
    const session = tryOn.startTryOn();
    tryOn.addPick(session.session.id, { slug: 'beige-linen-shirt', selection: makeUp() });
    await assert.rejects(() => tryOn.drawLook(session.session.id, { provider: 'google', apiKey: '' }), MissingKeyError);
  });

  it('rejects a mannequin we do not have', async () => {
    const session = tryOn.startTryOn();
    tryOn.addPick(session.session.id, { slug: 'beige-linen-shirt', selection: makeUp() });
    await assert.rejects(() => tryOn.drawLook(session.session.id, { provider: 'preview', mannequinId: 'unicorn' }), BadRequestError);
  });

  it('returns a ready job that never carries the key', async () => {
    const session = tryOn.startTryOn();
    tryOn.addPick(session.session.id, { slug: 'beige-linen-shirt', selection: makeUp() });
    const job = await tryOn.drawLook(session.session.id, { provider: 'preview', apiKey: 'secret-key' });

    assert.equal(job.status, 'ready');
    assert.ok(job.image.byteLength > 0);
    assert.ok(!JSON.stringify(tryOn.publicJob(job)).includes('secret-key'));
    assert.equal(tryOn.getLook(job.id).imageUrl, `/api/try-on/looks/${job.id}/image`);
    assert.equal(tryOn.getLookImage(job.id).mimeType, 'image/png');
  });

  it('records the failure on the job and reports it to the caller', async () => {
    const session = tryOn.startTryOn();
    tryOn.addPick(session.session.id, { slug: 'beige-linen-shirt', selection: makeUp() });

    // the real Google provider, with a fetch that answers the way Google does for a bad key
    const original = global.fetch;
    global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'API key not valid' } }) });
    try {
      await assert.rejects(
        () => tryOn.drawLook(session.session.id, { provider: 'google', apiKey: 'bad-key' }),
        (error) => {
          assert.equal(error.code, 'invalid_api_key');
          assert.match(error.message, /billing is enabled/);
          return true;
        },
      );
    } finally {
      global.fetch = original;
    }
  });
});

describe('the Google provider', () => {
  const provider = (status, body) => createGoogleProvider({ apiKey: 'k', fetchImpl: stubFetch(status, body) });

  it('returns the image it is given', async () => {
    const image = await provider(200, {
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] } }],
    }).draw({ prompt: 'x' });
    assert.deepEqual(image, { mimeType: 'image/png', data: 'AAAA', model: 'gemini-2.5-flash-image' });
  });

  it('reads snake_case inline data too', async () => {
    const image = await provider(200, {
      candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/jpeg', data: 'BBBB' } }] } }],
    }).draw({ prompt: 'x' });
    assert.equal(image.mimeType, 'image/jpeg');
  });

  it('translates a rejected key into something a shopper can act on', async () => {
    await assert.rejects(
      () => provider(400, { error: { message: 'API key not valid. Please pass a valid API key.' } }).draw({ prompt: 'x' }),
      (error) => {
        assert.equal(error.code, 'invalid_api_key');
        assert.equal(error.retryable, false);
        assert.equal(error.message, 'Google refused that key. Check that it is correct and that billing is enabled for it.');
        return true;
      },
    );
  });

  it('marks rate limits and outages as worth retrying', async () => {
    await assert.rejects(() => provider(429, { error: { status: 'RESOURCE_EXHAUSTED' } }).draw({ prompt: 'x' }), (error) => {
      assert.equal(error.code, 'rate_limited');
      assert.equal(error.retryable, true);
      return true;
    });
    await assert.rejects(() => provider(503, { error: { status: 'UNAVAILABLE' } }).draw({ prompt: 'x' }), (error) => {
      assert.equal(error.retryable, true);
      return true;
    });
  });

  it('explains a permission failure as a key problem', async () => {
    await assert.rejects(() => provider(403, { error: { status: 'PERMISSION_DENIED' } }).draw({ prompt: 'x' }), (error) => {
      assert.match(error.message, /billing is enabled/);
      return true;
    });
  });

  it('says so when the model answers with words instead of a picture', async () => {
    await assert.rejects(
      () => provider(200, { candidates: [{ content: { parts: [{ text: 'I cannot draw that.' }] } }] }).draw({ prompt: 'x' }),
      (error) => {
        assert.equal(error.code, 'no_image_returned');
        assert.match(error.message, /I cannot draw that/);
        return true;
      },
    );
  });

  it('turns a network failure into a retryable error', async () => {
    const offline = createGoogleProvider({
      apiKey: 'k',
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await assert.rejects(() => offline.draw({ prompt: 'x' }), (error) => {
      assert.equal(error.code, 'provider_unreachable');
      assert.equal(error.retryable, true);
      return true;
    });
  });
});
