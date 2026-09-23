/**
 * The two provider calls. Both are plain HTTPS requests constrained to JSON
 * output; neither is given a key, a signer handle or an RPC endpoint. Their
 * results are schema-validated by the caller before anything else sees them.
 */

type GeminiResponse = { candidates?: { content?: { parts?: { text?: string }[] } }[] };
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

/**
 * Stage 1 - context understanding, with an extended thinking budget so the model
 * can reason about an ambiguous text request before emitting the envelope.
 */
export async function callGemini(params: {
  apiKey: string;
  model: string;
  thinkingBudget: number;
  system: string;
  user: string;
}): Promise<unknown> {
  const payload = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      params.model,
    )}:generateContent`,
    {
      systemInstruction: { parts: [{ text: params.system }] },
      contents: [{ role: 'user', parts: [{ text: params.user }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        ...(params.thinkingBudget > 0
          ? { thinkingConfig: { thinkingBudget: params.thinkingBudget } }
          : {}),
      },
    },
    { 'x-goog-api-key': params.apiKey },
  );

  const text = (payload as GeminiResponse).candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? '')
    .join('')
    .trim();

  if (!text) throw new Error('gemini returned an empty candidate');
  return extractJson(text);
}

/** Stage 2 - action planning, constrained to a JSON object response. */
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
