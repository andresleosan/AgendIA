import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sarinWhatsAppUrl } from '../src/lib/sarin-contact.ts';

const output = fileURLToPath(new URL('../landing/out/', import.meta.url));
const html = await readFile(join(output, 'index.html'), 'utf8');
const links = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
const anchors = [...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((match) => match[1]);
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
const appOrigin = 'https://agendia-app.pages.dev';
const applicationLinks = [];
const visibleText = html.replace(/<[^>]*>/g, '');
assert.ok(visibleText.includes('Tus clientes agendan, la IA trabaja') && html.includes('aria-label="AgendIA"'), 'AgendIA identity and approved slogan must be visible.');
assert.ok(visibleText.includes('Asistente virtual: Sarin Bot') && visibleText.includes('Desarrollado por ALS Dev Studio'), 'Assistant and developer credits must remain visible.');
assert.ok(!/próximamente|aún no están disponibles/i.test(html), 'The product page must not retain the former launch notice.');
assert.ok(ids.has('planes') && ids.has('empezar'), 'Plans and access sections must be present.');
assert.ok(/data-offer-state="(?:loading|unavailable)"/.test(html), 'Variable prices require an accessible runtime offer state.');
assert.ok(!/(?:Semanal|Quincenal|Mensual):\s*\$/.test(html), 'The export must not advertise build-time subscription tariffs as current.');
for (const link of anchors) {
  if (link.startsWith('#')) {
    assert.ok(ids.has(link.slice(1)), `Navigation has no target: ${link}`);
    continue;
  }
  if (link === '/') continue;
  assert.ok(!link.startsWith('/'), 'The static homepage must not point at an unserved relative application route.');
  const url = new URL(link);
  assert.ok(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'Public destinations require clean HTTPS URLs.');
  if (url.origin === appOrigin) {
    const entry = /^\/dashboard(?:\/onboarding)?$/.test(url.pathname);
    assert.ok(entry || ['/ayuda', '/privacidad'].includes(url.pathname), 'Only approved application entry and information routes may be linked.');
    if (entry) applicationLinks.push(url.pathname);
  } else {
    assert.ok(url.href === 'https://www.alsdevstudio.com/' || url.href === sarinWhatsAppUrl, 'An unapproved external destination was exported.');
  }
}
if (applicationLinks.length) {
  assert.ok(applicationLinks.includes('/dashboard') && applicationLinks.includes('/dashboard/onboarding'), 'Enabled access requires both application entry actions.');
} else {
  assert.ok(anchors.includes('#planes') && anchors.includes('#empezar'), 'Coordinated access requires useful local actions.');
}
assert.ok(!html.includes('/_next/image?'), 'The export must not require the Next image server.');
const icons = ['brand/agendia-icon.svg', 'brand/agendia-192.png', 'brand/agendia-512.png'];
for (const file of ['404.html', '_headers', 'robots.txt', 'sitemap.xml', 'brand/sarin-welcome.png', 'brand/sarin-flight.png', 'brand/sarin-face-mark.png', 'favicon.ico', ...icons]) await stat(join(output, file));
for (const icon of icons) {
  assert.ok(links.some((link) => link.split(/[?#]/)[0] === '/' + icon), `Missing icon metadata: ${icon}`);
}
assert.ok(!links.some((link) => link.includes('/favicon.svg')), 'The previous line-art favicon must not be selected.');

let files = 0;
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), 'The public artifact must not contain symlinks.');
    if (entry.isDirectory()) { await inspect(file); continue; }
    files++;
    assert.ok(!entry.name.startsWith('.env') && entry.name !== '_worker.js' && !/\.map$/.test(entry.name), 'Unexpected private/executable artifact.');
    if (/\.(js|html|txt)$/.test(entry.name)) {
      const content = await readFile(file, 'utf8');
      assert.ok(!/firebaseapp\.com|securetoken\.googleapis|firestore\.googleapis|FIREBASE_ADMIN_PRIVATE_KEY|CF_ACCESS_CLIENT_SECRET|DEEPSEEK_API_KEY|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content), `Backend content found in ${file}`);
    }
  }
}
await inspect(output);

for (const asset of html.matchAll(/(?:src|href)="(\/(?:_next|brand)\/[^"?#]+)"/g)) {
  const path = resolve(output, '.' + asset[1]);
  assert.ok(path.startsWith(output), 'Asset escapes output directory.');
  await stat(path);
}
console.log(`Landing verified: ${files} public files, product sections and link targets present, ${applicationLinks.length ? 'approved application access enabled' : 'coordinated access'}, no backend configuration.`);
