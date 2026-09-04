/**
 * One-time setup against a Shopify store.
 *
 *   node scripts/shopify-setup.mjs definition          install the product metafield definition
 *   node scripts/shopify-setup.mjs config <handle>     put a fitting room on that product
 *   node scripts/shopify-setup.mjs check               list the products that have one
 *
 * Needs SHOPIFY_SHOP and SHOPIFY_ADMIN_TOKEN. Every command is safe to re-run.
 */
import { createAdminClient } from '../src/adapters/shopify/adminClient.js';
import { shopifyConfig } from '../src/adapters/shopify/config.js';
import { CONFIG_METAFIELD, PRODUCT_BY_HANDLE, ensureDefinition, writeProductConfig } from '../src/adapters/shopify/metafields.js';
import { toMetafieldConfig } from '../src/adapters/shopify/productMapper.js';
import { createShopifyProductSource } from '../src/adapters/shopify/productSource.js';
import { getProductBySlug } from '../src/modules/fitting-room/repository.js';

const [command, handle, template = 'beige-linen-shirt'] = process.argv.slice(2);
const client = createAdminClient();

const commands = {
  async definition() {
    const result = await ensureDefinition(client);
    console.log(
      result.created
        ? `Created the ${CONFIG_METAFIELD.namespace}.${CONFIG_METAFIELD.key} definition.`
        : `The ${CONFIG_METAFIELD.namespace}.${CONFIG_METAFIELD.key} definition already exists.`,
    );
  },

  async config() {
    if (!handle) throw new Error('Say which product: node scripts/shopify-setup.mjs config <handle> [template-slug]');

    const data = await client.request(PRODUCT_BY_HANDLE, {
      handle,
      namespace: CONFIG_METAFIELD.namespace,
      key: CONFIG_METAFIELD.key,
    });
    if (!data.productByHandle) throw new Error(`No product with handle "${handle}" on ${shopifyConfig.shop}.`);

    const config = toMetafieldConfig(getProductBySlug(template));
    await writeProductConfig(client, { productId: data.productByHandle.id, config });

    console.log(`Put a fitting room on "${data.productByHandle.title}" (${handle}), modelled on ${template}.`);
    console.log(`  ${Object.keys(config.groups).length} option groups · monogram ${config.monogram.enabled ? 'on' : 'off'} · made to measure ${config.madeToMeasure.enabled ? 'on' : 'off'}`);
  },

  async check() {
    const source = createShopifyProductSource({ client });
    const loaded = await source.warm();
    console.log(`${loaded} product(s) on ${shopifyConfig.shop} have a fitting room:`);
    for (const product of source.list()) {
      console.log(`  ${product.slug.padEnd(28)} ${(product.basePrice / 100).toFixed(2)} ${product.currency}`);
    }
    if (loaded === 0) console.log('  (none yet — run "config <handle>" on a product)');
  },
};

const run = commands[command];
if (!run) {
  console.error(`Usage: node scripts/shopify-setup.mjs <definition|config|check>`);
  process.exit(1);
}

try {
  await run();
} catch (error) {
  console.error(`Failed: ${error.message}`);
  process.exit(1);
}
