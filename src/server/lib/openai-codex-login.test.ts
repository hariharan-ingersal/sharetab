import { join } from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function loggedText(): Promise<string> {
  const { logger } = await import('@/server/lib/logger');
  return JSON.stringify(
    [logger.info, logger.warn, logger.error, logger.debug].flatMap((fn) => vi.mocked(fn).mock.calls),
  );
}

// Fails if any 6-character stretch of `secret` appears in `text` (as in meridian-login.test.ts)
function expectNoPartOf(secret: string, text: string | undefined) {
  if (secret.length < 6) throw new Error('expectNoPartOf needs a secret of 6+ characters');
  for (let i = 0; i + 6 <= secret.length; i++) {
    expect(text ?? '').not.toContain(secret.slice(i, i + 6));
  }
}

/** A JWT-shaped token the login code can decode, expiring `inSeconds` from now */
function jwtExpiringIn(inSeconds: number) {
  return [
    'header',
    Buffer.from(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + inSeconds,
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' },
      }),
    ).toString('base64url'),
    'sig',
  ].join('.');
}

const CODE = 'ac_CODESECRET0123456789';
const REFRESH_TOKEN = 'rt_REFRESHSECRET0123456789';
const LEAKY_TOKEN = 'eyLEAKYACCESSTOKEN0123456789';

describe('OpenAICodexLogin', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    process.env = { ...originalEnv, OPENAI_CODEX_DIR: '/tmp/test-chatgpt' };
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('startLogin returns an OAuth URL with Codex params', async () => {
    const { startLogin, cancelLogin } = await import('./openai-codex-login');
    const url = await startLogin();
    expect(url).toContain('https://auth.openai.com/oauth/authorize');
    expect(url).toContain('client_id=app_EMoamEEZ73f0CkXaXp7hrann');
    expect(url).toContain('code_challenge=');
    expect(url).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback');
    expect(url).toContain('codex_cli_simplified_flow=true');
    cancelLogin();
  });

  test('submitCode exchanges code and saves auth file', async () => {
    const mockWriteFileSync = vi.fn();
    vi.doMock('fs', () => ({
      mkdirSync: vi.fn(),
      renameSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: mockWriteFileSync,
      unlinkSync: vi.fn(),
    }));

    const { startLogin, submitCode } = await import('./openai-codex-login');
    await startLogin();

    const jwt = [
      'header',
      Buffer.from(
        JSON.stringify({
          exp: Math.floor(Date.now() / 1000) + 3600,
          'https://api.openai.com/profile': { email: 'test@example.com' },
          'https://api.openai.com/auth': {
            chatgpt_plan_type: 'plus',
            chatgpt_account_id: 'acct_123',
          },
        }),
      ).toString('base64url'),
      'sig',
    ].join('.');

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id_token: jwt,
          access_token: jwt,
          refresh_token: 'refresh-123',
        }),
        { status: 200 },
      ),
    );

    const result = await submitCode('abc');
    expect(result.success).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(mockWriteFileSync.mock.calls[0]![1]);
    expect(saved.auth_mode).toBe('Chatgpt');
    expect(saved.tokens.account_id).toBe('acct_123');
  });

  test('refreshIfNeeded refreshes expired auth', async () => {
    const expired = [
      'header',
      Buffer.from(
        JSON.stringify({
          exp: Math.floor(Date.now() / 1000) - 60,
          'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' },
        }),
      ).toString('base64url'),
      'sig',
    ].join('.');
    const fresh = [
      'header',
      Buffer.from(
        JSON.stringify({
          exp: Math.floor(Date.now() / 1000) + 3600,
          'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' },
        }),
      ).toString('base64url'),
      'sig',
    ].join('.');

    const mockWriteFileSync = vi.fn();
    vi.doMock('fs', () => ({
      mkdirSync: vi.fn(),
      renameSync: vi.fn(),
      readFileSync: () =>
        JSON.stringify({
          auth_mode: 'Chatgpt',
          tokens: {
            id_token: expired,
            access_token: expired,
            refresh_token: 'refresh-old',
            account_id: 'acct_123',
          },
        }),
      writeFileSync: mockWriteFileSync,
      unlinkSync: vi.fn(),
    }));

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id_token: fresh,
          access_token: fresh,
          refresh_token: 'refresh-new',
        }),
        { status: 200 },
      ),
    );

    const { refreshIfNeeded } = await import('./openai-codex-login');
    expect(await refreshIfNeeded()).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
      originator: 'codex_cli_rs',
    });
    expect(init?.body).toBeInstanceOf(URLSearchParams);
  });

  test('checkOpenAICodexHealth returns degraded for backend outages', async () => {
    const jwt = [
      'header',
      Buffer.from(
        JSON.stringify({
          exp: Math.floor(Date.now() / 1000) + 3600,
          'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' },
        }),
      ).toString('base64url'),
      'sig',
    ].join('.');

    vi.doMock('fs', () => ({
      mkdirSync: vi.fn(),
      renameSync: vi.fn(),
      readFileSync: () =>
        JSON.stringify({
          auth_mode: 'Chatgpt',
          tokens: {
            id_token: jwt,
            access_token: jwt,
            refresh_token: 'refresh-token',
            account_id: 'acct_123',
          },
        }),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    }));

    vi.mocked(fetch).mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const { checkOpenAICodexHealth } = await import('./openai-codex-login');
    await expect(checkOpenAICodexHealth()).resolves.toMatchObject({
      status: 'degraded',
      error: 'connect ECONNREFUSED',
      accountId: 'acct_123',
    });
  });

  test('checkOpenAICodexHealth caches healthy result for four hours on long-lived tokens', async () => {
    const jwt = [
      'header',
      Buffer.from(
        JSON.stringify({
          exp: Math.floor((Date.now() + 12 * 60 * 60 * 1000) / 1000),
          'https://api.openai.com/profile': { email: 'test@example.com' },
          'https://api.openai.com/auth': {
            chatgpt_plan_type: 'plus',
            chatgpt_account_id: 'acct_123',
          },
        }),
      ).toString('base64url'),
      'sig',
    ].join('.');

    vi.doMock('fs', () => ({
      mkdirSync: vi.fn(),
      renameSync: vi.fn(),
      readFileSync: () =>
        JSON.stringify({
          auth_mode: 'Chatgpt',
          tokens: {
            id_token: jwt,
            access_token: jwt,
            refresh_token: 'refresh-token',
            account_id: 'acct_123',
          },
        }),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    }));

    vi.mocked(fetch).mockResolvedValueOnce(new Response('[]', { status: 200 }));

    const { checkOpenAICodexHealth } = await import('./openai-codex-login');
    await checkOpenAICodexHealth();
    vi.advanceTimersByTime(3 * 60 * 60 * 1000 + 59 * 60 * 1000);
    await checkOpenAICodexHealth();

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('checkOpenAICodexHealth refreshes cache every five minutes when token is near expiry', async () => {
    const jwt = [
      'header',
      Buffer.from(
        JSON.stringify({
          exp: Math.floor((Date.now() + 10 * 60 * 1000) / 1000),
          'https://api.openai.com/profile': { email: 'test@example.com' },
          'https://api.openai.com/auth': {
            chatgpt_plan_type: 'plus',
            chatgpt_account_id: 'acct_123',
          },
        }),
      ).toString('base64url'),
      'sig',
    ].join('.');

    vi.doMock('fs', () => ({
      mkdirSync: vi.fn(),
      renameSync: vi.fn(),
      readFileSync: () =>
        JSON.stringify({
          auth_mode: 'Chatgpt',
          tokens: {
            id_token: jwt,
            access_token: jwt,
            refresh_token: 'refresh-token',
            account_id: 'acct_123',
          },
        }),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    }));

    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))
      .mockResolvedValueOnce(new Response('[]', { status: 200 }));

    const { checkOpenAICodexHealth } = await import('./openai-codex-login');
    await checkOpenAICodexHealth();
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await checkOpenAICodexHealth();

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('checkOpenAICodexHealth force option bypasses cache', async () => {
    const jwt = [
      'header',
      Buffer.from(
        JSON.stringify({
          exp: Math.floor((Date.now() + 12 * 60 * 60 * 1000) / 1000),
          'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' },
        }),
      ).toString('base64url'),
      'sig',
    ].join('.');

    vi.doMock('fs', () => ({
      mkdirSync: vi.fn(),
      renameSync: vi.fn(),
      readFileSync: () =>
        JSON.stringify({
          auth_mode: 'Chatgpt',
          tokens: {
            id_token: jwt,
            access_token: jwt,
            refresh_token: 'refresh-token',
            account_id: 'acct_123',
          },
        }),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    }));

    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))
      .mockResolvedValueOnce(new Response('[]', { status: 200 }));

    const { checkOpenAICodexHealth } = await import('./openai-codex-login');
    await checkOpenAICodexHealth();
    await checkOpenAICodexHealth({ force: true });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  describe('token-endpoint text stays out of errors, logs and stored status (#220)', () => {
    // Stored auth whose access token has expired, so the next use refreshes it
    function expiredStoredAuth() {
      const writeFileSync = vi.fn();
      const expired = jwtExpiringIn(-60);
      vi.doMock('fs', () => ({
        mkdirSync: vi.fn(),
        renameSync: vi.fn(),
        readFileSync: () =>
          JSON.stringify({
            auth_mode: 'Chatgpt',
            tokens: { id_token: expired, access_token: expired, refresh_token: REFRESH_TOKEN, account_id: 'acct_123' },
          }),
        writeFileSync,
        unlinkSync: vi.fn(),
      }));
      return { writeFileSync };
    }

    async function exchange(response: Response) {
      vi.doMock('fs', () => ({
        mkdirSync: vi.fn(),
        renameSync: vi.fn(),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        unlinkSync: vi.fn(),
      }));
      const { startLogin, submitCode } = await import('./openai-codex-login');
      await startLogin();
      vi.mocked(fetch).mockResolvedValueOnce(response);
      return submitCode(CODE);
    }

    test('a failed exchange reports only the status and an RFC 6749 error code, not the body', async () => {
      const result = await exchange(
        new Response(JSON.stringify({ error: 'invalid_grant', error_description: `code ${CODE} was used` }), {
          status: 400,
        }),
      );
      expect(result).toEqual({ success: false, error: 'Token exchange failed (400): invalid_grant' });
      expectNoPartOf(CODE, result.error);
      expectNoPartOf(CODE, await loggedText());
    });

    test('a failed exchange whose body is not JSON reports only the status', async () => {
      const result = await exchange(new Response(`<html>bad code ${CODE}</html>`, { status: 502 }));
      expect(result).toEqual({ success: false, error: 'Token exchange failed (502)' });
      expectNoPartOf(CODE, await loggedText());
    });

    test('a malformed success body on exchange fails with a fixed error', async () => {
      const result = await exchange(new Response(`${LEAKY_TOKEN} is not JSON`, { status: 200 }));
      expect(result).toEqual({ success: false, error: 'Malformed token response' });
      expectNoPartOf(LEAKY_TOKEN, await loggedText());
    });

    test('a wrongly typed success body on exchange saves nothing and quotes nothing', async () => {
      const result = await exchange(
        new Response(JSON.stringify({ id_token: 42, access_token: LEAKY_TOKEN, refresh_token: ['x'] }), {
          status: 200,
        }),
      );
      expect(result).toEqual({ success: false, error: 'Token exchange response did not include all required tokens' });
      expectNoPartOf(LEAKY_TOKEN, result.error);
    });

    // A JWT-shaped token whose payload isn't JSON: a JSON parser's message would quote it
    const UNDECODABLE_JWT = [
      'header',
      Buffer.from('ENDPOINTSECRET0123456789 is not JSON').toString('base64url'),
      'sig',
    ].join('.');

    test('an exchange returning a token whose claims do not decode fails with a fixed error', async () => {
      const result = await exchange(
        new Response(
          JSON.stringify({ id_token: UNDECODABLE_JWT, access_token: UNDECODABLE_JWT, refresh_token: 'rt_x' }),
          { status: 200 },
        ),
      );
      expect(result).toEqual({ success: false, error: 'Malformed token response' });
      expectNoPartOf('ENDPOINTSECRET0123456789', await loggedText());
    });

    test("the health check's refresh returning a token whose claims do not decode is degraded with a fixed error", async () => {
      expiredStoredAuth();
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ id_token: UNDECODABLE_JWT, access_token: UNDECODABLE_JWT }), { status: 200 }),
      );
      const { checkOpenAICodexHealth } = await import('./openai-codex-login');
      const result = await checkOpenAICodexHealth();
      expect(result).toMatchObject({ status: 'degraded', error: 'Malformed token response' });
      expectNoPartOf('ENDPOINTSECRET0123456789', JSON.stringify(result));
      expectNoPartOf('ENDPOINTSECRET0123456789', await loggedText());
    });

    test('a refresh answering an empty refresh_token keeps the stored one', async () => {
      const { writeFileSync } = expiredStoredAuth();
      const fresh = jwtExpiringIn(3600);
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ id_token: fresh, access_token: fresh, refresh_token: '' }), { status: 200 }),
      );
      const { refreshIfNeeded } = await import('./openai-codex-login');
      expect(await refreshIfNeeded()).toBe(true);
      const saved = JSON.parse(writeFileSync.mock.calls[0]![1] as string) as { tokens: { refresh_token: string } };
      expect(saved.tokens.refresh_token).toBe(REFRESH_TOKEN);
    });

    test('a failed refresh logs only the status and an RFC 6749 error code', async () => {
      const { writeFileSync } = expiredStoredAuth();
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'invalid_grant', error_description: `token ${REFRESH_TOKEN}` }), {
          status: 400,
        }),
      );
      const { refreshIfNeeded } = await import('./openai-codex-login');
      expect(await refreshIfNeeded()).toBe(false);
      expect(writeFileSync).not.toHaveBeenCalled();
      const { logger } = await import('@/server/lib/logger');
      expect(logger.warn).toHaveBeenCalledWith('openaiCodex.refresh.failed', { status: 400, error: 'invalid_grant' });
      expectNoPartOf(REFRESH_TOKEN, await loggedText());
    });

    test('a malformed refresh response fails with a fixed error', async () => {
      const { writeFileSync } = expiredStoredAuth();
      vi.mocked(fetch).mockResolvedValueOnce(new Response(`${LEAKY_TOKEN} is not JSON`, { status: 200 }));
      const { refreshIfNeeded } = await import('./openai-codex-login');
      await expect(refreshIfNeeded()).rejects.toThrow(new Error('Malformed token response'));
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    test('a wrongly typed refresh response saves nothing', async () => {
      const { writeFileSync } = expiredStoredAuth();
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ id_token: 42, access_token: LEAKY_TOKEN }), { status: 200 }),
      );
      const { refreshIfNeeded } = await import('./openai-codex-login');
      expect(await refreshIfNeeded()).toBe(false);
      expect(writeFileSync).not.toHaveBeenCalled();
      expectNoPartOf(LEAKY_TOKEN, await loggedText());
    });

    test("the health check's first refresh failing is a degraded status, not an unhandled error", async () => {
      expiredStoredAuth();
      vi.mocked(fetch).mockResolvedValueOnce(new Response(`${LEAKY_TOKEN} is not JSON`, { status: 200 }));
      const { checkOpenAICodexHealth } = await import('./openai-codex-login');
      const result = await checkOpenAICodexHealth();
      expect(result).toMatchObject({ status: 'degraded', error: 'Malformed token response', accountId: 'acct_123' });
      expectNoPartOf(LEAKY_TOKEN, JSON.stringify(result));
      expectNoPartOf(LEAKY_TOKEN, await loggedText());
    });

    test('a malformed response to the refresh after a 401 is a degraded status with a fixed error', async () => {
      const current = jwtExpiringIn(3600);
      vi.doMock('fs', () => ({
        mkdirSync: vi.fn(),
        renameSync: vi.fn(),
        readFileSync: () =>
          JSON.stringify({
            auth_mode: 'Chatgpt',
            tokens: { id_token: current, access_token: current, refresh_token: REFRESH_TOKEN, account_id: 'acct_123' },
          }),
        writeFileSync: vi.fn(),
        unlinkSync: vi.fn(),
      }));
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
        .mockResolvedValueOnce(new Response(`${LEAKY_TOKEN} is not JSON`, { status: 200 }));
      const { checkOpenAICodexHealth } = await import('./openai-codex-login');
      const result = await checkOpenAICodexHealth();
      expect(result).toMatchObject({ status: 'degraded', error: 'Malformed token response' });
      expectNoPartOf(LEAKY_TOKEN, JSON.stringify(result));
    });
  });

  test('logout clears pending login and removes auth file', async () => {
    const mockUnlinkSync = vi.fn();
    vi.doMock('fs', () => ({
      mkdirSync: vi.fn(),
      renameSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      unlinkSync: mockUnlinkSync,
    }));

    const { startLogin, isLoginInProgress, logout } = await import('./openai-codex-login');
    await startLogin();
    expect(isLoginInProgress()).toBe(true);

    const result = logout();
    expect(result.success).toBe(true);
    expect(isLoginInProgress()).toBe(false);
    expect(mockUnlinkSync.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test('logout succeeds when auth file is missing', async () => {
    vi.doMock('fs', () => ({
      mkdirSync: vi.fn(),
      renameSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      unlinkSync: () => {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      },
    }));

    const { logout } = await import('./openai-codex-login');
    expect(logout()).toEqual({ success: true });
  });

  // F1: a refresh token can be spent once, so concurrent callers share one refresh
  describe('one token refresh at a time', () => {
    /** auth.json held in memory: a write lands on a temporary file, which rename puts in place */
    function storedAuth(accessExpiresInSeconds: number) {
      const files = new Map<string, string>();
      const authPath = join(process.env.OPENAI_CODEX_DIR!, 'auth.json');
      const token = jwtExpiringIn(accessExpiresInSeconds);
      files.set(
        authPath,
        JSON.stringify({
          auth_mode: 'Chatgpt',
          tokens: { id_token: token, access_token: token, refresh_token: REFRESH_TOKEN, account_id: 'acct_123' },
        }),
      );
      vi.doMock('fs', () => ({
        mkdirSync: vi.fn(),
        readFileSync: (path: string) => {
          const data = files.get(path);
          if (data === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return data;
        },
        writeFileSync: (path: string, data: string) => void files.set(path, data),
        renameSync: (from: string, to: string) => {
          files.set(to, files.get(from)!);
          files.delete(from);
        },
        unlinkSync: (path: string) => void files.delete(path),
      }));
      const stored = () =>
        JSON.parse(files.get(authPath)!) as { tokens: { access_token: string; refresh_token: string } };
      return { files, authPath, token, stored };
    }

    /** The next token request stays unanswered until the returned function answers it */
    function heldTokenRequest() {
      let answer!: (response: Response) => void;
      vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)));
      return (body: object, status = 200) => answer(new Response(JSON.stringify(body), { status }));
    }

    const refreshBodies = () =>
      vi.mocked(fetch).mock.calls.map(([, init]) => (init?.body as URLSearchParams).get('refresh_token'));

    test('callers needing a refresh at once send one refresh and all get its tokens', async () => {
      const { files, authPath, stored } = storedAuth(-60);
      const answer = heldTokenRequest();
      const { getAccessTokenForApi, refreshIfNeeded, retryAfterUnauthorized } = await import('./openai-codex-login');

      const scans = [getAccessTokenForApi(), getAccessTokenForApi(), getAccessTokenForApi()];
      const poller = refreshIfNeeded();
      const after401 = retryAfterUnauthorized();
      const fresh = jwtExpiringIn(3600);
      answer({ id_token: fresh, access_token: fresh, refresh_token: 'rt_ROTATED' });

      for (const auth of await Promise.all([...scans, after401])) expect(auth?.accessToken).toBe(fresh);
      expect(await poller).toBe(true);
      expect(refreshBodies()).toEqual([REFRESH_TOKEN]);
      expect(stored().tokens.refresh_token).toBe('rt_ROTATED');
      expect([...files.keys()]).toEqual([authPath]);
    });

    test('forced refreshes after concurrent 401s send one refresh', async () => {
      storedAuth(3600);
      const answer = heldTokenRequest();
      const { retryAfterUnauthorized } = await import('./openai-codex-login');
      const calls = [retryAfterUnauthorized(), retryAfterUnauthorized(), retryAfterUnauthorized()];
      const fresh = jwtExpiringIn(3600);
      answer({ id_token: fresh, access_token: fresh, refresh_token: 'rt_ROTATED' });
      for (const auth of await Promise.all(calls)) expect(auth?.accessToken).toBe(fresh);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    test('a failed shared refresh is not sent again: forced callers get null, a still-valid token is kept', async () => {
      const { token } = storedAuth(3600);
      const answer = heldTokenRequest();
      const { getAccessTokenForApi, retryAfterUnauthorized } = await import('./openai-codex-login');
      const forced = retryAfterUnauthorized();
      const scan = getAccessTokenForApi();
      answer({ error: 'invalid_grant' }, 400);
      expect(await forced).toBeNull();
      expect((await scan)?.accessToken).toBe(token);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    test('an expired token whose shared refresh fails gives every caller null, after one refresh', async () => {
      storedAuth(-60);
      const answer = heldTokenRequest();
      const { getAccessTokenForApi } = await import('./openai-codex-login');
      const calls = [getAccessTokenForApi(), getAccessTokenForApi(), getAccessTokenForApi()];
      answer({ error: 'invalid_grant' }, 400);
      expect(await Promise.all(calls)).toEqual([null, null, null]);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    test('refreshes one after another each send the refresh token the last one stored', async () => {
      storedAuth(3600);
      const first = jwtExpiringIn(3600);
      const second = jwtExpiringIn(7200);
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id_token: first, access_token: first, refresh_token: 'rt_FIRST' })),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id_token: second, access_token: second, refresh_token: 'rt_SECOND' })),
        );
      const { retryAfterUnauthorized } = await import('./openai-codex-login');
      expect((await retryAfterUnauthorized())?.accessToken).toBe(first);
      expect((await retryAfterUnauthorized())?.accessToken).toBe(second);
      expect(refreshBodies()).toEqual([REFRESH_TOKEN, 'rt_FIRST']);
    });

    test('a refresh that throws leaves none in flight, so the next call refreshes', async () => {
      storedAuth(-60);
      const fresh = jwtExpiringIn(3600);
      vi.mocked(fetch)
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id_token: fresh, access_token: fresh, refresh_token: 'rt_ROTATED' })),
        );
      const { getAccessTokenForApi } = await import('./openai-codex-login');
      await expect(getAccessTokenForApi()).rejects.toThrow('fetch failed');
      expect((await getAccessTokenForApi())?.accessToken).toBe(fresh);
    });
  });

  // F3: a 307/308 re-sends a POST body to wherever it points, and these bodies hold credentials
  test('both token requests refuse redirects', async () => {
    vi.doMock('fs', () => ({
      mkdirSync: vi.fn(),
      renameSync: vi.fn(),
      readFileSync: () => {
        const expired = jwtExpiringIn(-60);
        return JSON.stringify({
          auth_mode: 'Chatgpt',
          tokens: { id_token: expired, access_token: expired, refresh_token: REFRESH_TOKEN, account_id: 'acct_123' },
        });
      },
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    }));
    const fresh = jwtExpiringIn(3600);
    const tokens = () => new Response(JSON.stringify({ id_token: fresh, access_token: fresh, refresh_token: 'rt_x' }));
    vi.mocked(fetch).mockResolvedValueOnce(tokens()).mockResolvedValueOnce(tokens());
    const { refreshIfNeeded, startLogin, submitCode } = await import('./openai-codex-login');

    expect(await refreshIfNeeded()).toBe(true);
    await startLogin();
    expect(await submitCode(CODE)).toEqual({ success: true });

    const inits = vi.mocked(fetch).mock.calls.map(([, init]) => init);
    expect(inits).toHaveLength(2);
    for (const init of inits) expect(init?.redirect).toBe('error');
  });
});
