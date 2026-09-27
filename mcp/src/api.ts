import { existsSync, readFileSync } from 'node:fs';
import type { McpConfig, ResolvedToken } from './config.js';

/** No usable agent token yet (owner not signed in, several owners, wrong data dir). The message names the fix. */
export class McpSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpSetupError';
  }
}

/** The agent answered with an error status. `code` is the API's `error` field. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** No HTTP answer: the agent is down, or the call timed out after it may have run. */
export class ApiUnreachableError extends Error {
  constructor(
    message: string,
    readonly timedOut: boolean,
  ) {
    super(message);
    this.name = 'ApiUnreachableError';
  }
}

export type Fetch = typeof fetch;

export class NexusApi {
  constructor(
    private readonly config: McpConfig,
    private readonly fetchImpl: Fetch = fetch,
    /** Re-runs token discovery while the server has none, so signing in later needs no client restart. */
    private readonly resolveToken?: () => ResolvedToken,
  ) {}

  get<T>(path: string): Promise<T> {
    return this.call<T>('GET', path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.call<T>('POST', path, body);
  }

  private async execute(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ response: Response; text: string }> {
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(`${this.config.apiUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      // The timeout also covers the body, so read it inside the same guard.
      text = await response.text();
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new ApiUnreachableError(
        timedOut
          ? `nexusPay agent did not answer within ${this.config.timeoutMs} ms`
          : `nexusPay agent is not reachable at ${this.config.apiUrl}`,
        timedOut,
      );
    }
    return { response, text };
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.config.agentToken) {
      if (!this.resolveToken) throw new McpSetupError('nexusPay MCP server has no agent token');
      try {
        Object.assign(this.config, this.resolveToken());
      } catch (err) {
        throw new McpSetupError(err instanceof Error ? err.message : String(err));
      }
    }
    let { response, text } = await this.execute(this.config.agentToken, method, path, body);

    // Self-healing on 401 when token was discovered from a file: re-read file once and retry.
    if (response.status === 401 && this.config.tokenSource !== 'env') {
      try {
        if (this.config.tokenSource && existsSync(this.config.tokenSource)) {
          const freshToken = readFileSync(this.config.tokenSource, 'utf8').trim();
          if (freshToken && freshToken !== this.config.agentToken) {
            this.config.agentToken = freshToken;
            const retried = await this.execute(freshToken, method, path, body);
            response = retried.response;
            text = retried.text;
          }
        }
      } catch {
        // Non-fatal if re-reading fails; proceed with reporting 401
      }
    }

    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON error pages are reported by status only.
    }

    if (!response.ok) {
      const fields = (payload ?? {}) as { error?: unknown; message?: unknown };
      const code = typeof fields.error === 'string' ? fields.error : `http_${response.status}`;
      const message = typeof fields.message === 'string' ? fields.message : code;
      throw new ApiError(response.status, code, message);
    }
    return payload as T;
  }
}
