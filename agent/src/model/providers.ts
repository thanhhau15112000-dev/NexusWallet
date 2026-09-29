/**
 * The provider call. It is a plain HTTPS request constrained to JSON output;
 * it is never given a key, a signer handle or an RPC endpoint. The result is
 * schema-validated by the caller before anything else sees it.
 */

type GroqResponse = { choices?: { message?: { content?: string } }[] };

/** Providers occasionally wrap JSON in prose or fences. Extract the first object. */
function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new Error(`model did not return JSON: ${trimmed.slice(0, 160)}`);
    }
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs = 25_000,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 240)}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/** Stage 1 (intent) and stage 2 (action plan), constrained to a JSON object response. */
export async function callGroq(params: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
}): Promise<unknown> {
  const payload = await postJson(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: params.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.user },
      ],
    },
    { authorization: `Bearer ${params.apiKey}` },
  );

  const content = (payload as GroqResponse).choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('groq returned an empty choice');
  return extractJson(content);
}
