# JSON model configuration / JSON 模型配置

入口：**模型 → API → 从 JSON 导入**。粘贴配置，或点击「使用示例 JSON」
后修改，再点击右上角「导入」。

Open **Models → API → Import from JSON**, paste a configuration (or use the
editable example), then press **Import**.

Each import creates **one new connection** with one or more manual models. It
does not overwrite existing connections/models or change the selected chat model.
Re-importing the same JSON creates another connection.

## Example

```json
{
  "name": "My API",
  "protocol": "openai-completions",
  "endpoint": "https://example.com/v1",
  "apiKey": "YOUR_API_KEY",
  "models": [
    {
      "id": "model-id",
      "name": "My model",
      "contextWindow": 128000,
      "maxTokens": 16384,
      "thinking": ["off"],
      "generation": {
        "maxTokens": 8192,
        "temperature": 0.7,
        "samplingParams": { "top_p": 0.9 }
      }
    }
  ]
}
```

Replace the endpoint, API key and model ID with your provider's values. More
models can be appended to the `models` array.

This is Arxd's connection JSON format, **not** a full Pi `models.json` or another
app's settings file. Unknown fields are rejected rather than silently ignored.

## Connection fields

| Field | Meaning |
| --- | --- |
| `name` | Required connection display name. |
| `endpoint` | Required HTTP(S) base URL, without embedded credentials, query parameters or a fragment. |
| `protocol` | Defaults to `openai-completions`. Also accepts `openai-responses`, `openai-codex-responses`, `anthropic-messages` and `google-generative-ai`. |
| `preset` | Defaults to `custom`. API presets `deepseek`, `openai`, `anthropic` and `google` are also accepted; they do not fill in or override the endpoint/protocol. |
| `auth` | Defaults to `key`. Set to `none` for an unauthenticated local service and omit `apiKey`/`headers`. Google requires key authentication. |
| `apiKey` | Optional literal key; no environment-variable, file or command expansion. Omit credentials to configure them later in the connection editor. |
| `headers` | Optional object of string-valued authentication headers, for example `{"Authorization":"Bearer …"}`. Headers-only authentication is supported. |
| `models` | Required array of 1–128 models. |

Account/OAuth connections must use the **Accounts** tab; JSON import does not
accept `auth: "account"` or account provider presets.

## Model fields

| Field | Meaning |
| --- | --- |
| `id` | Required upstream model ID; unique within this connection. |
| `name` | Display name; defaults to `id`. |
| `contextWindow` | Integer token limit; defaults to 128000. Allowed range: 8192–10000000. |
| `maxTokens` | Model's output ceiling; defaults to 16384. Must be at least 16 and no greater than `contextWindow`. |
| `thinking` | Nonempty list of supported levels; defaults to `["off"]`. Values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `enabled` | Boolean; defaults to `true`. |
| `generation` | Optional overrides: `maxTokens`, `temperature`, `cacheRetention`, `samplingParams`, `timeoutMs`. Validated against the model/protocol, like the regular editor. The default reply budget is the model's output ceiling. |
| `compat` | Optional Pi compatibility options for the chosen protocol; unsupported fields are rejected. Not available for Google. |

For small-context models, explicitly set an appropriate `maxTokens` as well as
`contextWindow`. Imported models have the same text-only input and zero local
pricing metadata as manually added models.

## Storage and validation

- Strict JSON only, up to **64 KiB UTF-8**. No comments or trailing commas.
- All models and credentials are validated before writing. Connection and model
  records are published in a single SQLite transaction.
- API keys and headers use the existing encrypted device credential store, not
  the workspace database. The raw JSON draft is not saved.
- Import does not call the endpoint. Its initial details page skips automatic
  model discovery; **Refresh models** remains available explicitly.
- Running tasks must finish before configuration can change. Existing workspace
  limits of 32 connections and 1024 stored models still apply.
