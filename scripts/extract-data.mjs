import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(path.join(root, 'index.html'), 'utf-8');

const match = html.match(
  /<script id="pageData" type="application\/json">([\s\S]*?)<\/script>/
);
if (!match) {
  throw new Error('Could not find #pageData script tag in index.html');
}

const data = JSON.parse(match[1]);
writeFileSync(
  path.join(root, 'data', 'procedures.json'),
  JSON.stringify(data),
  'utf-8'
);

console.log(
  `Extracted ${data.procedures.length} procedures / ${data.roles.length} roles into data/procedures.json`
);
