/**
 * Runtime configuration for the fitting room module.
 * Every value can be overridden with an environment variable so the module can
 * be dropped into an existing storefront without code changes.
 */
const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const float = (value, fallback) => {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: int(process.env.PORT, 3000),
  host: process.env.HOST ?? '0.0.0.0',
  currency: process.env.FITTING_ROOM_CURRENCY ?? 'EUR',
  locale: process.env.FITTING_ROOM_LOCALE ?? 'en',
  /** VAT applied on top of the customised line price. 0 disables tax lines. */
  taxRate: float(process.env.FITTING_ROOM_TAX_RATE, 0.2),
  /** Lead time of a stock garment, in days, before any option surcharge. */
  baseLeadTimeDays: int(process.env.FITTING_ROOM_BASE_LEAD_TIME_DAYS, 3),
  /** How long an abandoned fitting room draft is kept, in milliseconds. */
  sessionTtlMs: int(process.env.FITTING_ROOM_SESSION_TTL_MS, 1000 * 60 * 60 * 24),
  maxQuantity: int(process.env.FITTING_ROOM_MAX_QUANTITY, 10),
};

export default config;
