import { createApp } from './index.js';

const port = Number(process.env.PORT ?? 3001);
const app = createApp();

app.listen(port, () => {
  console.log(`[Stream C] VenuePilot API listening on http://localhost:${port}`);
});
