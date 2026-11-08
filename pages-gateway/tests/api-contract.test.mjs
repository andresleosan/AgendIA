import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { isCommercialApiRequest } from '../worker.mjs';

test('gateway covers the inherited commercial API methods without admitting administration', async () => {
  const root = fileURLToPath(new URL('../../src/app/', import.meta.url));
  let checked = 0;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) { await visit(file); continue; }
      if (entry.name !== 'route.ts') continue;
      const route = '/' + relative(root, dirname(file)).replaceAll('\\', '/').replace(/\[slug\]/g, 'demo-shop').replace(/\[sha256\]/g, 'a'.repeat(64)).replace(/\[[^\]]+\]/g, 'demo_id');
      const source = await readFile(file, 'utf8');
      const methods = new Set([...source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)/g)].map(value => value[1]));
      if (source.includes('supportCollectionHandlers(false)') || source.includes('supportMessageHandlers(false)')) { methods.add('GET'); methods.add('POST'); }
      const blocked = /^\/api\/(?:admin|internal|whatsapp)(?:\/|$)/.test(route);
      for (const method of methods) {
        checked++;
        assert.equal(isCommercialApiRequest(new Request('https://agendia-app.pages.dev' + route, { method })), !blocked, method + ' ' + route);
      }
    }
  }
  await visit(join(root, 'api'));
  assert.ok(checked > 100, 'The complete inherited route inventory must be inspected');
});
