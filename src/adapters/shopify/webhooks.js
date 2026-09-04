import { verifyWebhookHmac } from './auth.js';
import { auditLineItem } from './lineItems.js';

const TAG = 'fitting-room-price-mismatch';

const ADD_TAGS = `
  mutation TagOrder($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

/**
 * Check a new order against the fitting room.
 *
 * Cart line properties come from the browser, so a determined customer can edit
 * the price a line claims. The cart transform cannot verify a signature — it has
 * no crypto and no network — so the guarantee is completed here: every
 * customised line is re-priced from its own make-up and the order is tagged when
 * the numbers disagree. That is detection, not prevention; see the README for
 * the draft-order alternative if prevention is required.
 *
 * @param {object} order the `orders/create` payload
 * @param {{client?: {request: Function}, secret?: string}} [options]
 */
export const auditOrder = async (order, { client, secret } = {}) => {
  const findings = (order.line_items ?? []).map((lineItem) => ({
    lineItemId: lineItem.id,
    title: lineItem.title,
    ...auditLineItem(lineItem, { slug: lineItem.handle ?? lineItem.product_handle, secret }),
  }));

  const customised = findings.filter((finding) => finding.customised);
  const mismatches = customised.filter((finding) => !finding.ok);

  if (mismatches.length > 0 && client && order.admin_graphql_api_id) {
    await client.request(ADD_TAGS, { id: order.admin_graphql_api_id, tags: [TAG] });
  }

  return {
    orderId: order.id ?? null,
    customisedLines: customised.length,
    mismatches,
    tagged: mismatches.length > 0 && Boolean(client),
  };
};

/**
 * The `orders/create` webhook endpoint. Verifies the HMAC over the raw body
 * before it parses anything.
 */
export const handleOrdersCreate = async ({ rawBody, headers, client, secret }) => {
  verifyWebhookHmac(rawBody, headers['x-shopify-hmac-sha256'], secret ? { secret } : undefined);
  const order = JSON.parse(Buffer.from(rawBody).toString('utf8'));
  return auditOrder(order, { client, secret });
};
