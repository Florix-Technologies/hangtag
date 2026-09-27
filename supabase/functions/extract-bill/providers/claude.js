// Claude provider: reads the bill (PDF as a document, photos as images) and returns JSON that matches EXTRACTION_SCHEMA.
// client: an Anthropic SDK client (index.ts creates it; tests pass a fake with the same shape).
import { DEFAULT_MODEL, buildRequest, parseModelResponse } from "../core.js";

export function createClaudeProvider(client, { model } = {}) {
  const useModel = model || DEFAULT_MODEL;
  return {
    name: "claude",
    model: useModel,
    /* → { ok:true, result } or { ok:false, status, error, message } */
    async extract({ data, mimeType, fileName }) {
      // streaming: long bills can produce long outputs; finalMessage() collects the complete response
      const message = await client.beta.messages.stream(buildRequest({ model: useModel, data, mimeType, fileName })).finalMessage();
      return parseModelResponse(message, { provider: "claude", model: useModel });
    },
  };
}
