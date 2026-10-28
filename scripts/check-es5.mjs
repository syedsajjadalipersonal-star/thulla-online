// Parses every file of the ES5 engine build as ECMAScript 5.
// Nakama's JavaScript runtime only runs ES5, so any newer syntax here would fail on the server.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'acorn';

const dir = new URL('../build/engine-es5/', import.meta.url).pathname;
let failed = 0;
for (const name of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
  const file = join(dir, name);
  try {
    parse(readFileSync(file, 'utf8'), { ecmaVersion: 5, sourceType: 'script' });
    console.log(`ES5 ok    ${name}`);
  } catch (error) {
    failed++;
    console.error(`NOT ES5   ${name}: ${error.message}`);
  }
}
if (failed) {
  console.error(`${failed} file(s) are not valid ES5.`);
  process.exit(1);
}
