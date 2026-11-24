import type { AIProvider } from '../provider';
import type { ReceiptExtractionResult } from '../schema';
import { receiptExtractionSchema } from '../schema';
import { RECEIPT_EXTRACTION_PROMPT } from '../prompts/receipt-extraction';
import { checkOpenAICodexHealth, getAccessTokenForApi, retryAfterUnauthorized } from '@/server/lib/openai-codex-login';

const DEFAULT_MODEL = 'gpt-6.1-sol';
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const ORIGINATOR = 'codex_cli_rs';

function extractTextFromContent(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }

  let text = '';
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const typed = part as { type?: string; text?: string };
    if ((typed.type === 'output_text' || typed.type === 'text') && typed.text) {
      text += typed.text;
    }
  }

  return text.trim() ? text : null;
}

function extractTextFromOutputItem(item: unknown): string | null {
  if (!item || typeof item !== 'object') {
    return null;
  }

  return extractTextFromContent((item as { content?: unknown }).content);
}

function extractTextPayload(response: unknown): string {
  if (!response || typeof response !== 'object') {
    throw new Error('OpenAI Codex returned an invalid response');
  }

  const root = response as Record<string, unknown>;
  if (typeof root.output_text === 'string' && root.output_text.trim()) {
    return root.output_text;
  }

  const output = root.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const text = extractTextFromOutputItem(item);
      if (text) {
        return text;
      }
    }
  }

  throw new Error('OpenAI Codex returned no text output');
}

// The backend's error text is the upstream's to word: it can quote the request, and it ends up
// in the server log, the admin page and the admin audit log (which the admin export includes).
// Only an error code shaped like an identifier (`usage_limit_reached`) is kept: lowercase
// letters, digits and underscores, which no free-text message or token is.
const CODEX_ERROR_CODE = /^[a-z][a-z0-9_]{1,63}$/;

function codexErrorCode(value: unknown): string | null {
  return typeof value === 'string' && CODEX_ERROR_CODE.test(value) ? value : null;
}

/** The error code in a backend error body or a failed response (`code`, or `error.code` / `error.type`) */
function extractCodexErrorCode(response: unknown): string | null {
  if (!response || typeof response !== 'object') {
    return null;
  }

  const record = response as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === 'object') {
    const { code, type } = error as { code?: unknown; type?: unknown };
    return codexErrorCode(code) ?? codexErrorCode(type);
  }
  return codexErrorCode(error) ?? codexErrorCode(record.code);
}

export function extractTextFromCodexStream(body: string): string {
  let deltaText = '';
  let finalText: string | null = null;
  let completed = false;

  for (const chunk of body.split(/\r?\n\r?\n+/)) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;

    const data = trimmed
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.replace(/^data:\s?/, ''))
      .join('\n');

    if (!data || data === '[DONE]') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== 'object') continue;
    const event = parsed as Record<string, unknown>;

    switch (event.type) {
      case 'response.output_text.delta':
        if (typeof event.delta === 'string') {
          deltaText += event.delta;
        }
        break;
      case 'response.output_item.done': {
        const itemText = extractTextFromOutputItem(event.item);
        if (itemText) {
          finalText = itemText;
        }
        break;
      }
      case 'response.failed': {
        const code = extractCodexErrorCode(event.response) ?? extractCodexErrorCode(event);
        throw new Error(`OpenAI Codex stream failed${code ? `: ${code}` : ''}`);
      }
      case 'response.incomplete': {
        const reason =
          event.response &&
          typeof event.response === 'object' &&
          'incomplete_details' in event.response &&
          (
            event.response as {
              incomplete_details?: { reason?: unknown };
            }
          ).incomplete_details?.reason;
        throw new Error(`OpenAI Codex stream incomplete: ${codexErrorCode(reason) ?? 'unknown'}`);
      }
      case 'response.completed':
        completed = true;
        if (!finalText && event.response) {
          try {
            finalText = extractTextPayload(event.response);
          } catch {
            // ignore and fall back to accumulated deltas
          }
        }
        break;
      default:
        break;
    }
  }

  const text = (finalText ?? deltaText).trim();
  if (text) {
    return text;
  }

  if (completed) {
    throw new Error('OpenAI Codex stream completed without text output');
  }

  throw new Error('OpenAI Codex stream ended before response.completed');
}

export function isCodexSseResponse(raw: string, contentType?: string | null): boolean {
  const normalizedContentType = contentType?.toLowerCase() ?? '';
  if (normalizedContentType.includes('text/event-stream')) {
    return true;
  }

  const trimmed = raw.trim();
  return (
    trimmed.startsWith('event:') ||
    trimmed.includes('\nevent:') ||
    trimmed.startsWith('data:') ||
    trimmed.includes('\ndata:')
  );
}

async function performRequest(body: object): Promise<string> {
  const auth = await getAccessTokenForApi();
  if (!auth?.accessToken) {
    throw new Error('OpenAI Codex provider requires ChatGPT OAuth login');
  }

  const headers = new Headers({
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    originator: ORIGINATOR,
  });
  if (auth.accountId) {
    headers.set('ChatGPT-Account-ID', auth.accountId);
  }

  let response = await fetch(`${CODEX_BASE_URL}/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (response.status === 401) {
    const refreshed = await retryAfterUnauthorized();
    if (!refreshed?.accessToken) {
      throw new Error('OpenAI Codex authentication expired');
    }

    headers.set('Authorization', `Bearer ${refreshed.accessToken}`);
    if (refreshed.accountId) {
      headers.set('ChatGPT-Account-ID', refreshed.accountId);
    }

    response = await fetch(`${CODEX_BASE_URL}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  }

  if (!response.ok) {
    // The status and at most an error code: the body is upstream text (see CODEX_ERROR_CODE)
    const code = extractCodexErrorCode(await response.json().catch(() => null));
    throw new Error(`OpenAI Codex request failed (${response.status})${code ? `: ${code}` : ''}`);
  }

  const raw = await response.text();
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('OpenAI Codex returned an empty response body');
  }

  if (isCodexSseResponse(trimmed, response.headers.get('content-type'))) {
    return extractTextFromCodexStream(trimmed);
  }

  // A JSON parser's message quotes the start of the body, so a body that isn't JSON fails with a fixed error
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('OpenAI Codex returned an unexpected response format');
  }
  return extractTextPayload(parsed);
}

/**
 * The model to request: OPENAI_CODEX_MODEL, or the default when it's unset, blank or only
 * spaces. A blanked Unraid template field or .env line sets it to '', which would otherwise be
 * sent as the model name (#222).
 */
export function resolveCodexModel(model: string | undefined): string {
  return model?.trim() || DEFAULT_MODEL;
}

export class OpenAICodexProvider implements AIProvider {
  readonly name = 'openai-codex';
  private model: string;

  constructor(model?: string) {
    this.model = resolveCodexModel(model);
  }

  async extractReceipt(
    imageBuffer: Buffer,
    mimeType: string,
    correctionHint?: string,
  ): Promise<ReceiptExtractionResult> {
    const base64 = imageBuffer.toString('base64');
    const prompt = correctionHint
      ? `${RECEIPT_EXTRACTION_PROMPT}\n\nThe user has provided a correction. Apply it to improve accuracy:\n<user_correction>${correctionHint.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</user_correction>\n\nReturn only valid JSON.`
      : `${RECEIPT_EXTRACTION_PROMPT}\n\nReturn only valid JSON.`;

    const payload = {
      model: this.model,
      instructions: '',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            {
              type: 'input_image',
              image_url: `data:${mimeType};base64,${base64}`,
            },
          ],
        },
      ],
      tools: [],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      store: false,
      stream: true,
      include: [],
    };

    const text = (await performRequest(payload))
      .trim()
      .replace(/^```(?:json)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .trim();

    return receiptExtractionSchema.parse(JSON.parse(text));
  }

  async isAvailable(): Promise<boolean> {
    try {
      return (await checkOpenAICodexHealth()).status === 'healthy';
    } catch {
      return false;
    }
  }
}
