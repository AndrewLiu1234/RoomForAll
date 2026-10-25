import fs from 'node:fs';
import { createApp } from './index.js';

if (typeof process.loadEnvFile === 'function' && fs.existsSync('.env')) {
  process.loadEnvFile('.env');
}

const port = Number(process.env.PORT ?? 3001);
const app = createApp();

app.listen(port, () => {
  console.log(`[Stream C] VenuePilot API listening on http://localhost:${port}`);
});
