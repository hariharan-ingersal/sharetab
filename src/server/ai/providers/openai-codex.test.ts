import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getAccessTokenForApi, retryAfterUnauthorized } from '@/server/lib/openai-codex-login';
import { extractTextFromCodexStream, isCodexSseResponse, OpenAICodexProvider, resolveCodexModel } from './openai-codex';

vi.mock('@/server/lib/openai-codex-login', () => ({
  checkOpenAICodexHealth: vi.fn(),
  getAccessTokenForApi: vi.fn(),
  retryAfterUnauthorized: vi.fn(),
}));

// Upstream text that must not reach an error message (F5): it goes to the server log, the
// admin page and the admin audit log
const SECRET = 'sk_UPSTREAMSECRET0123456789';

describe('extractTextFromCodexStream', () => {
  test('returns final message text from streamed events', () => {
    const body = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":""}]}}\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"{\\"total\\": 12"}\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"34}"}\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"{\\"total\\": 1234}"}]}}\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1"}}\n',
    ].join('\n');

    expect(extractTextFromCodexStream(body)).toBe('{"total": 1234}');
  });

  test('falls back to delta text when no final item is present', () => {
    const body = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1"}}\n',
    ].join('\n');

    expect(extractTextFromCodexStream(body)).toBe('hello');
  });

  test('throws on failed stream events with the error code, not the upstream message', () => {
    const failed = {
      type: 'response.failed',
      response: { error: { code: 'usage_limit_reached', message: `limit reached for ${SECRET}` } },
    };
    const body = [
      `event: response.failed\ndata: ${JSON.stringify(failed)}\n`,
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1"}}\n',
    ].join('\n');

    expect(() => extractTextFromCodexStream(body)).toThrow(
      new Error('OpenAI Codex stream failed: usage_limit_reached'),
    );
  });

  test('a failed stream event with only a message throws a fixed error', () => {
    const failed = { type: 'response.failed', response: { error: { message: `token ${SECRET} expired` } } };
    expect(() => extractTextFromCodexStream(`data: ${JSON.stringify(failed)}\n`)).toThrow(
      new Error('OpenAI Codex stream failed'),
    );
  });

  test('an incomplete stream keeps only a code-shaped reason', () => {
    const incomplete = (reason: string) =>
      `data: ${JSON.stringify({ type: 'response.incomplete', response: { incomplete_details: { reason } } })}\n`;
    expect(() => extractTextFromCodexStream(incomplete('max_output_tokens'))).toThrow(
      new Error('OpenAI Codex stream incomplete: max_output_tokens'),
    );
    expect(() => extractTextFromCodexStream(incomplete(`cut off near ${SECRET}`))).toThrow(
      new Error('OpenAI Codex stream incomplete: unknown'),
    );
  });

  test('detects data-only SSE payloads', () => {
    const body = [
      'data: {"type":"response.output_text.delta","delta":"hello"}\n',
      'data: {"type":"response.completed","response":{"id":"resp_1"}}\n',
    ].join('\n');

    expect(isCodexSseResponse(body, 'text/event-stream')).toBe(true);
    expect(isCodexSseResponse(body, 'application/json')).toBe(true);
  });
});

describe('backend errors reach errors as a status and an error code only (F5)', () => {
  beforeEach(() => {
    vi.mocked(getAccessTokenForApi).mockResolvedValue({
      accessToken: 'at_x',
      refreshToken: 'rt_x',
      idToken: 'id_x',
      accountId: 'acct_123',
      email: null,
      planType: null,
      expiresAt: null,
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function scanError(response: Response): Promise<string> {
    vi.mocked(fetch).mockResolvedValueOnce(response);
    const error: unknown = await new OpenAICodexProvider()
      .extractReceipt(Buffer.from('img'), 'image/jpeg')
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }

  test('a JSON error body keeps its error code, never its message', async () => {
    const message = await scanError(
      new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: `quota for ${SECRET}` } }), {
        status: 429,
      }),
    );
    expect(message).toBe('OpenAI Codex request failed (429): rate_limit_exceeded');
  });

  test('a body that is not JSON, such as a proxy page echoing the request, gives the status only', async () => {
    const message = await scanError(new Response(`<html>Authorization: Bearer ${SECRET}</html>`, { status: 502 }));
    expect(message).toBe('OpenAI Codex request failed (502)');
  });

  test('a token-shaped value in the error code is not kept', async () => {
    const message = await scanError(new Response(JSON.stringify({ error: SECRET, detail: SECRET }), { status: 400 }));
    expect(message).toBe('OpenAI Codex request failed (400)');
  });

  test('a 401 the refresh cannot fix fails with a fixed error', async () => {
    vi.mocked(retryAfterUnauthorized).mockResolvedValue(null);
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 401 }));
    await expect(new OpenAICodexProvider().extractReceipt(Buffer.from('img'), 'image/jpeg')).rejects.toThrow(
      new Error('OpenAI Codex authentication expired'),
    );
  });

  test('a success body that is not JSON fails with a fixed error, not the parser message quoting it', async () => {
    const message = await scanError(
      new Response(`${SECRET} not json`, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect(message).toBe('OpenAI Codex returned an unexpected response format');
  });
});

describe('resolveCodexModel', () => {
  test('uses the model configured', () => {
    expect(resolveCodexModel('gpt-5.4-mini')).toBe('gpt-5.4-mini');
  });

  test('falls back to the default when unset, blank or only spaces (e.g. a blanked Unraid field, #222)', () => {
    expect(resolveCodexModel(undefined)).toBe('gpt-6.1-sol');
    expect(resolveCodexModel('')).toBe('gpt-6.1-sol');
    expect(resolveCodexModel('   ')).toBe('gpt-6.1-sol');
  });

  test('trims the spaces around a configured model', () => {
    expect(resolveCodexModel(' gpt-5.5 ')).toBe('gpt-5.5');
  });
});
