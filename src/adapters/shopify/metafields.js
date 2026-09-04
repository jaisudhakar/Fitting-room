import { shopifyConfig } from './config.js';

/**
 * The fitting room lives on one JSON metafield per product, so a merchant can
 * see and edit it in the admin, and so nothing about the module needs a
 * database of its own.
 */
export const CONFIG_METAFIELD = shopifyConfig.metafield;

export const METAFIELD_DEFINITION = {
  name: 'Fitting room',
  namespace: CONFIG_METAFIELD.namespace,
  key: CONFIG_METAFIELD.key,
  description: 'Which options this garment can be customised with, and what they cost.',
  type: 'json',
  ownerType: 'PRODUCT',
  access: { admin: 'MERCHANT_READ_WRITE', storefront: 'PUBLIC_READ' },
};

export const CREATE_DEFINITION = `
  mutation CreateFittingRoomDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id name namespace key }
      userErrors { field message code }
    }
  }
`;

export const PRODUCT_BY_HANDLE = `
  query FittingRoomProduct($handle: String!, $namespace: String!, $key: String!) {
    productByHandle(handle: $handle) {
      id
      handle
      title
      description
      featuredImage { url }
      priceRangeV2 { minVariantPrice { amount currencyCode } }
      variants(first: 1) { nodes { id price } }
      metafield(namespace: $namespace, key: $key) { value }
    }
  }
`;

export const PRODUCTS_WITH_FITTING_ROOM = `
  query FittingRoomProducts($cursor: String, $namespace: String!, $key: String!) {
    products(first: 50, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        title
        description
        featuredImage { url }
        priceRangeV2 { minVariantPrice { amount currencyCode } }
        variants(first: 1) { nodes { id price } }
        metafield(namespace: $namespace, key: $key) { value }
      }
    }
  }
`;

export const SET_PRODUCT_CONFIG = `
  mutation SetFittingRoomConfig($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key }
      userErrors { field message code }
    }
  }
`;

/** Install the metafield definition. Safe to run more than once. */
export const ensureDefinition = async (client) => {
  try {
    const data = await client.request(CREATE_DEFINITION, { definition: METAFIELD_DEFINITION });
    return { created: true, definition: data.metafieldDefinitionCreate.createdDefinition };
  } catch (error) {
    const taken = (error.details ?? []).some((detail) => detail.code === 'TAKEN');
    if (taken) return { created: false, definition: null };
    throw error;
  }
};

/** Write a product's fitting room configuration. */
export const writeProductConfig = (client, { productId, config }) =>
  client.request(SET_PRODUCT_CONFIG, {
    metafields: [
      {
        ownerId: productId,
        namespace: CONFIG_METAFIELD.namespace,
        key: CONFIG_METAFIELD.key,
        type: 'json',
        value: JSON.stringify(config),
      },
    ],
  });
