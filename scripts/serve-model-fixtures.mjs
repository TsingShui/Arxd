import { writeFile } from 'node:fs/promises';
import { modelServer } from '../tests/model-server.mjs';
const server = await modelServer(17651);
console.log(JSON.stringify({ ready: true, port: 17651, mode: 'deterministic-local-http' }));
process.on('SIGTERM', async () => {
  const records = server.requests.map(({ path, headers, body, status, inputTokens, contextWindow }) => ({ path, model: body.model, status, inputTokens, contextWindow,
    maxTokens: body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens ?? body.generationConfig?.maxOutputTokens,
    temperature: body.temperature ?? body.generationConfig?.temperature, topP: body.top_p,
    authPresent: !!headers.authorization || !!headers['x-api-key'] || !!headers['x-goog-api-key'],
    probeHeaderPresent: !!headers['x-arxd-probe'],
  }));
  await writeFile(process.argv[2], JSON.stringify({ mode: 'deterministic-local-http', requests: records }, null, 2));
  await server.close(); process.exit(0);
});
