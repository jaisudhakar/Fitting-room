/** Public surface of the fitting room module. */
export * from './catalog.js';
export * from './errors.js';
export { formatMoney, priceSelection } from './pricing.js';
export {
  defaultSelection,
  findProductBySlug,
  getProductBySlug,
  getSizeChart,
  listProducts,
  resolveGroup,
  resolveGroups,
  resolveSteps,
} from './repository.js';
export { SIZING_CONSTANTS, estimateMeasurements, recommendSize } from './sizing.js';
export {
  InMemorySessionStore,
  getSessionStore,
  setSessionStore,
  sweepSessions,
} from './session.js';
export { normalizeSelection, validateSelection } from './validator.js';
export * as fittingRoomService from './service.js';
export * as fittingRoomController from './controller.js';
export { registerFittingRoomRoutes } from './routes.js';
