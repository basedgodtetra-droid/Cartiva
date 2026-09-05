// Maintainer CLI only. No public admin route, database download, or raw SQL API.
// Uses existing server-side bridge environment; never prints its credentials.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const [operation, ...words] = process.argv.slice(2);
if (!['inspect', 'seed'].includes(operation)) throw new Error('Usage: pnpm knowledge inspect "coke zero" | pnpm knowledge seed');
const server = await createServer({ configFile: false, root, resolve: { alias: { '@': root } }, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { sharedCommand } = await server.ssrLoadModule('/lib/kroger-shared-client.ts');
  if (operation === 'seed') {
    await sharedCommand({ op: 'knowledge.seed' });
    process.stdout.write('Reviewed product vocabulary and category semantics saved.\n');
  } else {
    const { parseProductIntent } = await server.ssrLoadModule('/lib/product-search-intent.ts');
    const { conceptForIntent } = await server.ssrLoadModule('/lib/knowledge/foundations.ts');
    const concept = conceptForIntent(parseProductIntent(words.join(' ')));
    if (!concept) throw new Error('Only safe product-level vocabulary can be inspected.');
    const context = await sharedCommand({ op: 'knowledge.lookup', keys: [concept.id] });
    process.stdout.write(JSON.stringify({ concept, context, note: 'Identity memory only. No current price or stock is inferred.' }, null, 2) + '\n');
  }
} catch { process.stderr.write('Knowledge storage unavailable or input unsupported. Check the existing server-side bridge configuration.\n'); process.exitCode = 1; }
finally { await server.close(); }
