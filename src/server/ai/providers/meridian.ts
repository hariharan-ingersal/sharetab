/*
 * SECURITY: reassess before enabling Meridian (adding `meridian` to AI_PROVIDER_PRIORITY).
 *
 * These findings from the OAuth review were deferred while only openai-codex is in use. The
 * Codex login has the fixes; Meridian's login (src/server/lib/meridian-login.ts) doesn't yet.
 * The admin page's Meridian card says a review is needed, and while Meridian isn't configured
 * nothing starts it (admin.testAIProvider and completeMeridianLogin refuse).
 *
 * - F2, concurrent token refreshes: `refreshIfNeeded` has no single-flight, and Claude Code
 *   (run by Meridian) refreshes the same .credentials.json on its own. Two refreshes sent with
 *   one single-use refresh token leave one refused, and a stale read-then-write can replace
 *   newer tokens. Impact: forced Claude re-login, false expiry emails. Fix as for Codex
 *   (`refreshInFlight` in openai-codex-login.ts), plus re-reading the file before writing in
 *   case Claude Code refreshed meanwhile; no lock is shared with Claude Code's process.
 * - F3, redirects: the token requests in `submitCode` and `refreshIfNeeded` follow redirects,
 *   and a 307/308 re-sends the POST body (refresh token, or code and PKCE verifier) to the new
 *   origin. Impact: credential leak if the token endpoint ever redirects somewhere hostile.
 *   Fix: `redirect: 'error'`.
 * - F4, credential writes: .credentials.json is written in place with writeFileSync, so Claude
 *   Code or a health check can read a partial file (which reads as logged out), and
 *   `mode: 0o600` only applies when the file is created (one copied in or restored as 0644
 *   stays readable). Fix: write through `writeCredentialFile` (src/server/lib/credential-file.ts).
 * - F8, Claude Code inside the container: Meridian runs Claude Code with
 *   `permissionMode: "bypassPermissions"` and passes it this server's whole environment except
 *   its own Anthropic keys (DATABASE_URL, AUTH_SECRET, SMTP and provider credentials), as the
 *   same user, so it could also read /app/chatgpt/auth.json. What keeps a crafted receipt image
 *   from getting it to read or send any of that is Meridian blocking Claude Code's file, shell
 *   and web tools (BLOCKED_BUILTIN_TOOLS, checked in @rynfar/meridian 1.87.0), not ShareTab.
 *   Impact if that block regresses: secrets and other providers' logins exfiltrated.
 *
 * Before enabling: fix F2–F4 or accept them; check BLOCKED_BUILTIN_TOOLS and the permission
 * mode in the installed Meridian version (and again on every Meridian upgrade); keep guest
 * uploads off and registration closed so only trusted people can submit images; and accept
 * that the Claude and ChatGPT logins then share one trust boundary.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider } from '../provider';
import type { ReceiptExtractionResult } from '../schema';
import { receiptExtractionSchema } from '../schema';
import { RECEIPT_EXTRACTION_PROMPT } from '../prompts/receipt-extraction';
import { logger } from '@/server/lib/logger';

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

let meridianPort: number | null = null;
let meridianStarting: Promise<number> | null = null;
let lastStartError: string | null = null;

/** Why the last proxy start failed, or null once a start has succeeded. */
export function getMeridianStartError(): string | null {
  return lastStartError;
}

/**
 * Starts the proxy and settles once it answers or the start fails; never
 * rejects (a failure is logged and kept for getMeridianStartError()).
 */
export async function startMeridianProxy(): Promise<void> {
  try {
    await ensureMeridian();
  } catch {
    // ensureMeridian() already logged and recorded the failure.
  }
}

// startProxyServer resolves before the server listens, and a failed listen
// only logs when silent is off, so poll /health until a 10 s deadline shared
// by every probe (headers and body), so a listener that stalls can't stretch
// it. A body shaped like Meridian's (one of its statuses plus a version) means
// it is listening, even when it answers 503 as unhealthy (e.g. no boot
// identity); anything else on the port means our listen failed. isAvailable()
// then only checks for a 2xx, which a "degraded" proxy (auth unverifiable)
// also returns. With no Claude login, Meridian 1.83 and later answer 503
// "unhealthy" (1.71 answered "degraded"), so the provider reads as unavailable
// and the app falls back to the next one.
const MERIDIAN_READY_DEADLINE_MS = 10_000;
const MERIDIAN_HEALTH_STATUSES = new Set(['healthy', 'degraded', 'unhealthy', 'draining']);

function isMeridianHealth(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const { status, version } = body as { status?: unknown; version?: unknown };
  return typeof status === 'string' && MERIDIAN_HEALTH_STATUSES.has(status) && version !== undefined;
}

async function waitForMeridian(port: number): Promise<void> {
  const deadline = Date.now() + MERIDIAN_READY_DEADLINE_MS;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(2_000, deadline - Date.now()));
    let body: unknown;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
      body = await res.json().catch((err: unknown) => {
        if (controller.signal.aborted) throw err; // stalled mid-body: no answer yet
        return null; // not JSON: something else answers
      });
    } catch {
      clearTimeout(timer);
      await new Promise((r) => setTimeout(r, Math.min(250, Math.max(0, deadline - Date.now()))));
      continue;
    }
    clearTimeout(timer);
    if (isMeridianHealth(body)) return;
    throw new Error(`Something other than Meridian answers on port ${port}`);
  }
  throw new Error(`Meridian proxy did not answer on port ${port}`);
}

async function ensureMeridian(): Promise<number> {
  if (meridianPort) return meridianPort;
  if (meridianStarting) return meridianStarting;

  meridianStarting = (async () => {
    // Refresh expired OAuth token before starting the proxy
    const { refreshIfNeeded } = await import('../../lib/meridian-login');
    await refreshIfNeeded();

    const { startProxyServer } = await import('@rynfar/meridian');
    const port = parseInt(process.env.MERIDIAN_PORT ?? '3457', 10);
    const proxy = await startProxyServer({
      port,
      host: '127.0.0.1',
      silent: true,
    });
    try {
      await waitForMeridian(port);
    } catch (err) {
      // Stop the half-started proxy (it runs timers even if its listen
      // failed) so a retry doesn't leave it behind.
      await proxy.close().catch(() => undefined);
      throw err;
    }
    meridianPort = port;
    lastStartError = null;
    logger.info('meridian.start.ok', { port });
    return port;
  })().catch((err: unknown) => {
    // Forget the failed start so the next call tries again (after a new
    // login, for example) instead of failing until the server restarts.
    meridianStarting = null;
    lastStartError = (err instanceof Error ? err.message : String(err)) || 'Meridian proxy failed to start';
    logger.error('meridian.start.failed', {
      error: lastStartError,
      ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
    });
    throw err;
  });

  return meridianStarting;
}

export class MeridianProvider implements AIProvider {
  readonly name = 'meridian';
  private client: Anthropic | null = null;

  private async getClient(): Promise<Anthropic> {
    if (this.client) return this.client;
    const port = await ensureMeridian();
    this.client = new Anthropic({
      apiKey: 'x',
      baseURL: `http://127.0.0.1:${port}`,
      maxRetries: 0,
    });
    return this.client;
  }

  async extractReceipt(
    imageBuffer: Buffer,
    mimeType: string,
    correctionHint?: string,
  ): Promise<ReceiptExtractionResult> {
    const client = await this.getClient();
    const base64 = imageBuffer.toString('base64');
    const start = Date.now();
    const prompt = correctionHint
      ? `${RECEIPT_EXTRACTION_PROMPT}\n\nThe user has provided a correction. Apply it to improve accuracy:\n<user_correction>${correctionHint.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</user_correction>`
      : RECEIPT_EXTRACTION_PROMPT;

    const stream = client.messages.stream(
      {
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
        max_tokens: 4000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mimeType as ImageMediaType,
                  data: base64,
                },
              },
              {
                type: 'text',
                text: prompt,
              },
            ],
          },
        ],
      },
      { timeout: 120_000 },
    );

    const response = await stream.finalMessage();
    console.log(`[meridian] completed in ${Date.now() - start}ms, content blocks: ${response.content?.length}`);

    const textBlock = response.content?.find((c: { type: string }) => c.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('Meridian returned no text response');
    }

    const cleaned = textBlock.text
      .trim()
      .replace(/^```(?:json)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .trim();
    const raw = JSON.parse(cleaned);
    return receiptExtractionSchema.parse(raw);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const port = await ensureMeridian();
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
