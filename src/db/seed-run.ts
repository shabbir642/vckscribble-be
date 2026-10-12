import { ensureSchema } from './index.js';
import { seedWords } from './seed.js';

ensureSchema();
const r = seedWords();
console.log(`seed: ${r.inserted} inserted, ${r.skipped} already present, ${r.total} total`);
