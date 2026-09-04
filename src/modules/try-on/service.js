import { createHash, randomUUID } from 'node:crypto';

import { BadRequestError, NotFoundError } from '../fitting-room/errors.js';
import { MONOGRAM_POSITIONS, MONOGRAM_THREADS } from '../fitting-room/catalog.js';
import { resolveGroups } from '../fitting-room/repository.js';
import * as fittingRoom from '../fitting-room/service.js';
import { DEFAULT_MANNEQUIN_ID, MANNEQUINS, MAX_PICKS, getMannequin } from './catalog.js';
import { MissingKeyError, ProviderError } from './errors.js';
import { buildPrompt } from './prompt.js';
import { createGoogleProvider } from './providers/google.js';
import { createPreviewProvider } from './providers/preview.js';
import {
  clearJobs,
  createJob,
  createSession,
  readJob,
  readSession,
  saveSession,
  updateJob,
} from './session.js';

/** Turn a validated fitting room make-up into a hanger on the rail. */
const toPick = (product, selection, price) => {
  const labels = {};
  for (const group of resolveGroups(product)) {
    const value = group.values.find((candidate) => candidate.id === selection.options[group.id]);
    if (value) labels[group.id] = value.label;
  }

  const monogram = selection.monogram
    ? {
        text: selection.monogram.text,
        position: (MONOGRAM_POSITIONS.find((item) => item.id === selection.monogram.position) ?? {}).label ?? selection.monogram.position,
        thread: (MONOGRAM_THREADS.find((item) => item.id === selection.monogram.thread) ?? {}).label ?? selection.monogram.thread,
      }
    : null;

  return {
    id: fittingRoom.variantKey(product, selection),
    slug: product.slug,
    title: product.title,
    details: labels,
    monogram,
    swatch: (resolveGroups(product).find((group) => group.id === 'fabric')?.values ?? []).find(
      (value) => value.id === selection.options.fabric,
    )?.swatch ?? null,
    unitPrice: price.unitPrice,
    formattedUnitPrice: price.formatted.unitPrice,
    currency: price.currency,
    selection,
  };
};

const publicPick = ({ selection, ...pick }) => pick;

const view = (session) => ({
  session: {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: new Date(session.expiresAt).toISOString(),
  },
  picks: session.picks.map(publicPick),
  pieces: session.picks.length,
  maxPicks: MAX_PICKS,
  mannequins: MANNEQUINS,
});

export const startTryOn = () => view(createSession());

export const getTryOn = (sessionId) => view(readSession(sessionId));

/**
 * Add the make-up currently in the fitting room to the rail. The selection is
 * validated first — you cannot try on a shirt that cannot be made.
 */
export const addPick = (sessionId, { slug, selection }) => {
  const session = readSession(sessionId);
  if (session.picks.length >= MAX_PICKS) {
    throw new BadRequestError(`A look holds at most ${MAX_PICKS} pieces. Remove one first.`);
  }

  const quoted = fittingRoom.quoteSelection(slug, selection ?? {});
  const pick = toPick(quoted.product, quoted.selection, quoted.price);

  if (session.picks.some((existing) => existing.id === pick.id)) {
    return { ...view(session), added: false, pick: publicPick(pick) };
  }

  const updated = saveSession(session, { picks: [...session.picks, pick] });
  return { ...view(updated), added: true, pick: publicPick(pick) };
};

export const removePick = (sessionId, pickId) => {
  const session = readSession(sessionId);
  const picks = session.picks.filter((pick) => pick.id !== pickId);
  if (picks.length === session.picks.length) throw new NotFoundError(`No pick "${pickId}" on this rail.`);
  return view(saveSession(session, { picks }));
};

/** "Start over": empty the rail and forget the looks drawn from it. */
export const resetTryOn = (sessionId) => {
  const session = readSession(sessionId);
  clearJobs(sessionId);
  return view(saveSession(session, { picks: [] }));
};

const resolveProvider = ({ apiKey, provider = process.env.TRY_ON_PROVIDER ?? 'google', model }) => {
  if (provider === 'preview') return createPreviewProvider();
  const key = apiKey ?? process.env.GOOGLE_API_KEY ?? '';
  if (!key) throw new MissingKeyError();
  return createGoogleProvider({ apiKey: key, model: model ?? process.env.TRY_ON_MODEL ?? undefined });
};

/**
 * Draw the look. The API key is used for this one call and is never stored on
 * the job, the session or the log.
 *
 * @returns {Promise<object>} the finished job (succeeded or failed)
 */
export const drawLook = async (sessionId, { apiKey, mannequinId = DEFAULT_MANNEQUIN_ID, notes, provider, model } = {}) => {
  const session = readSession(sessionId);
  if (session.picks.length === 0) throw new BadRequestError('Add a piece to the rail before drawing the look.');
  if (!getMannequin(mannequinId)) throw new BadRequestError(`No mannequin with id "${mannequinId}".`);

  const drawer = resolveProvider({ apiKey, provider, model });
  const prompt = buildPrompt({ picks: session.picks, mannequinId, notes });

  const job = createJob({
    id: `look_${randomUUID().replace(/-/g, '')}`,
    sessionId,
    status: 'drawing',
    provider: drawer.id,
    model: drawer.model,
    mannequinId,
    pickIds: session.picks.map((pick) => pick.id),
    prompt,
    createdAt: new Date().toISOString(),
  });

  try {
    const image = await drawer.draw({ prompt });
    const bytes = Buffer.from(image.data, 'base64');
    return updateJob(job, {
      status: 'ready',
      finishedAt: new Date().toISOString(),
      image: {
        mimeType: image.mimeType,
        bytes,
        byteLength: bytes.byteLength,
        checksum: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
      },
    });
  } catch (error) {
    const failure = error instanceof ProviderError ? error : new ProviderError(error.message);
    updateJob(job, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: { code: failure.code, message: failure.message, retryable: failure.retryable },
    });
    throw failure;
  }
};

/** The job without its bytes — the image is fetched from its own endpoint. */
export const publicJob = (job) => ({
  id: job.id,
  status: job.status,
  provider: job.provider,
  model: job.model,
  mannequinId: job.mannequinId,
  pickIds: job.pickIds,
  prompt: job.prompt,
  createdAt: job.createdAt,
  finishedAt: job.finishedAt ?? null,
  error: job.error ?? null,
  imageUrl: job.status === 'ready' ? `/api/try-on/looks/${job.id}/image` : null,
  image: job.image ? { mimeType: job.image.mimeType, byteLength: job.image.byteLength, checksum: job.image.checksum } : null,
});

export const getLook = (jobId) => publicJob(readJob(jobId));

export const getLookImage = (jobId) => {
  const job = readJob(jobId);
  if (job.status !== 'ready' || !job.image) throw new NotFoundError(`Look "${jobId}" has no image.`);
  return job.image;
};
