import { createServer } from 'node:http';
import { attachmentScript } from '../src/agent/offline-provider.ts';

/** Deterministic protocol fixtures over real HTTP, never a live model. */
export async function modelServer(port = 0, contextWindow) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let data = ''; for await (const part of request) { data += part; if (data.length > 524288) { response.writeHead(413).end(); return; } }
    const body = data ? JSON.parse(data) : {};
    const url = new URL(request.url, 'http://fixture');
    const strings = [];
    const collect = (value) => { if (typeof value === 'string') strings.push(value); else if (value && typeof value === 'object') for (const item of Object.values(value)) collect(item); };
    collect(body);
    const text = strings.join('\n');
    const toolProbe = text.includes('TOOL_ROUND_PROBE');
    const toolComplete = text.includes('fourProtocolToolProbe');
    const marker = /<arxd-file id="[a-f0-9-]+" sha256="([a-f0-9]{64})" path="([^"]*)" format="([^"]*)"\/>/.exec(text);
    const invoke = toolProbe && !toolComplete && marker;
    const argumentsJson = invoke ? JSON.stringify({ script: attachmentScript(marker[2], marker[1], marker[3]), timeoutMs: 30000 }) : '';
    const observed = { path: url.pathname, headers: request.headers, body, status: 200 };
    requests.push(observed);
    const capacity = contextWindow ?? (url.pathname.startsWith('/small-phone') ? 8192 : undefined);
    const inputTokens = capacity ? Math.ceil(JSON.stringify(body).length / 4) : 4;
    observed.inputTokens = inputTokens; observed.contextWindow = capacity;
    const budget = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens ?? body.generationConfig?.maxOutputTokens ?? 16;
    if (capacity && inputTokens + budget > capacity) { observed.status = 400; response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'context_length_exceeded: fixture context limit' } })); return; }
    if (url.pathname.startsWith('/hang')) { request.on('close', () => response.end()); return; }
    if (url.pathname.startsWith('/error')) { observed.status = 401; response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Rejected ' + request.headers.authorization } })); return; }
    if (toolProbe && toolComplete && url.pathname.includes('/responses')) {
      const calls = body.input.filter((item) => item.type === 'function_call');
      const outputs = body.input.filter((item) => item.type === 'function_call_output');
      if (!outputs.length || outputs.some((item) => item.call_id.includes('|') || !calls.some((call) => call.call_id === item.call_id))) { response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Invalid Responses tool-call identity' } })); return; }
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (value, event) => response.write(`${event ? 'event: ' + event + '\n' : ''}data: ${JSON.stringify(value)}\n\n`);
    const summarizing = JSON.stringify(body.messages ?? body.input ?? []).includes('You are a context summarization assistant.');
    const answer = capacity && budget < 8 ? 'M' : summarizing ? 'COMPACTED_SMALL_CONTEXT' : 'MODEL_OK';
    if (url.pathname.includes('/responses')) {
      if (invoke) {
        const item = { type: 'function_call', id: 'fc_probe', call_id: 'call_probe', name: 'shell', arguments: argumentsJson, status: 'completed' };
        send({ type: 'response.created', response: { id: 'resp_tool', status: 'in_progress', output: [] } });
        send({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } });
        send({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: argumentsJson });
        send({ type: 'response.output_item.done', output_index: 0, item });
        send({ type: 'response.completed', response: { id: 'resp_tool', status: 'completed', model: body.model, output: [item], usage: { input_tokens: inputTokens, output_tokens: 64, total_tokens: inputTokens + 64 } } });
        response.end(); return;
      }
      const item = { type: 'message', id: 'msg_probe', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] };
      const base = { id: 'resp_probe', object: 'response', created_at: 1, model: body.model, status: 'in_progress', output: [] };
      send({ type: 'response.created', response: base });
      send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      send({ type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [] } });
      send({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: answer });
      send({ type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: item.id, text: answer });
      send({ type: 'response.output_item.done', output_index: 0, item });
      send({ type: 'response.completed', response: { ...base, status: 'completed', output: [item], usage: { input_tokens: inputTokens, output_tokens: 3, total_tokens: inputTokens + 3, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
    } else if (url.pathname.startsWith('/anthropic')) {
      const sendEvent = (type, value) => send({ type, ...value }, type);
      sendEvent('message_start', { message: { id: 'msg_probe', type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, usage: { input_tokens: 4, output_tokens: 0 } } });
      if (invoke) {
        sendEvent('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_probe', name: 'shell', input: {} } });
        sendEvent('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: argumentsJson } });
        sendEvent('content_block_stop', { index: 0 });
        sendEvent('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 64 } });
        sendEvent('message_stop', {}); response.end(); return;
      }
      sendEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      sendEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer } });
      sendEvent('content_block_stop', { index: 0 });
      sendEvent('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } });
      sendEvent('message_stop', {});
    } else if (url.pathname.startsWith('/google')) {
      send({ candidates: [{ content: { role: 'model', parts: invoke ? [{ functionCall: { id: 'call_probe', name: 'shell', args: JSON.parse(argumentsJson) } }] : [{ text: answer }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: invoke ? 64 : 3, totalTokenCount: invoke ? 68 : 7 } });
    } else {
      if (invoke) {
        send({ id: 'chat_tool', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_probe', type: 'function', function: { name: 'shell', arguments: argumentsJson } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: inputTokens, completion_tokens: 64, total_tokens: inputTokens + 64 } });
        response.write('data: [DONE]\n\n'); response.end(); return;
      }
      send({ id: 'chat_probe', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] });
      send({ id: 'chat_probe', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: capacity && budget < 8 ? 'length' : 'stop' }], usage: { prompt_tokens: inputTokens, completion_tokens: 3, total_tokens: inputTokens + 3 } });
      response.write('data: [DONE]\n\n');
    }
    response.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { requests, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}
