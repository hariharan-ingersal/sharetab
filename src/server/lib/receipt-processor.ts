import type { PrismaClient } from '@/generated/prisma/client';
import type { Prisma } from '@/generated/prisma/client';
import type { AIProvider } from '../ai/provider';
import { getAIProvidersWithFallback, clearProviderCache } from '../ai/registry';
import { logger } from './logger';
import { normalizeDate } from './normalize-date';
import { AppError } from './app-error';

/**
 * Lock a receipt's row for a change to its items, amounts or details, and refuse the change once
 * an expense has been made from it, or its group is archived. The expense is the receipt's record
 * of how the bill was split: a deleted one counts too, since restoring brings it back as it was,
 * and an expense is corrected by editing the expense. The lock is the one an expense being made
 * from the receipt takes (FOR SHARE), so a change either lands before that expense, whose page then
 * refuses the split it showed, or waits for it and is refused here. Call it first in the
 * transaction that makes the change.
 */
export async function lockEditableReceipt(tx: Prisma.TransactionClient, receiptId: string): Promise<void> {
  const [receipt] = await tx.$queryRaw<{ groupId: string | null }[]>`
    SELECT "groupId" FROM "Receipt" WHERE "id" = ${receiptId} FOR NO KEY UPDATE`;
  if (!receipt) {
    throw new AppError('NOT_FOUND', 'receiptNotFound');
  }
  if (await tx.expense.findUnique({ where: { receiptId }, select: { id: true } })) {
    throw new AppError('BAD_REQUEST', 'receiptAlreadyHasExpense');
  }
  if (receipt.groupId) {
    const group = await tx.group.findUnique({ where: { id: receipt.groupId }, select: { archivedAt: true } });
    if (group?.archivedAt) {
      throw new AppError('BAD_REQUEST', 'archivedEditExpense');
    }
  }
}

interface ProcessReceiptImageOptions {
  db: PrismaClient;
  receiptId: string;
  receipt: { imagePath: string; mimeType: string };
  correctionHint?: string;
  /** The currency saved when the scan can't tell which the receipt is in: its group's, when it has one (#361) */
  fallbackCurrency: string;
  logPrefix?: string;
}

/**
 * Shared receipt processing logic used by both authenticated and guest flows.
 * Reads the image file, calls the AI provider, creates receipt items in DB,
 * and updates the receipt record with the extraction result.
 */
export async function processReceiptImage({
  db,
  receiptId,
  receipt,
  correctionHint,
  fallbackCurrency,
  logPrefix = 'receipt',
}: ProcessReceiptImageOptions) {
  const { readFile } = await import('fs/promises');
  const { resolveUploadPath } = await import('./upload-dir');
  const filepath = resolveUploadPath(receipt.imagePath);
  const imageBuffer = await readFile(filepath);

  logger.info(`${logPrefix}.processing`, {
    receiptId,
    imageSize: imageBuffer.length,
    correctionHint: correctionHint ?? null,
  });

  const start = Date.now();
  let provider: AIProvider | null = null;
  let result: Awaited<ReturnType<AIProvider['extractReceipt']>> | null = null;
  let lastError: unknown;

  for (let pass = 0; pass < 2 && !result; pass++) {
    const providers = await getAIProvidersWithFallback();

    for (const candidate of providers) {
      try {
        result = await candidate.extractReceipt(imageBuffer, receipt.mimeType, correctionHint);
        provider = candidate;
        break;
      } catch (err) {
        lastError = err;
        logger.warn(`${logPrefix}.extractFailed`, {
          receiptId,
          provider: candidate.name,
          error: err instanceof Error ? err.message : String(err),
          pass,
        });
      }
    }

    if (!result && pass === 0) {
      // Cache can become stale after auth expiration; refresh once and retry all providers.
      clearProviderCache();
    }
  }

  if (!result || !provider) {
    throw new Error(
      `Receipt extraction failed across configured providers: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }
  const extraction = result;
  const usedProvider = provider;

  logger.info(`${logPrefix}.extracted`, {
    receiptId,
    provider: usedProvider.name,
    items: extraction.items.length,
    total: extraction.total,
    durationMs: Date.now() - start,
  });

  const normalizedDate = normalizeDate(extraction.date);
  const currency = extraction.currency ?? fallbackCurrency;

  // Replace items and finalize the receipt atomically — a crash or a
  // concurrent reprocess must never leave a COMPLETED receipt with missing
  // or duplicated items.
  await db.$transaction(async (tx) => {
    // A scan can outlive its claim (one stale after 15 minutes is claimed again, and that scan can
    // complete and the receipt become an expense): it never replaces the items of a receipt that
    // an expense was made from in the meantime
    await lockEditableReceipt(tx, receiptId);
    await tx.receiptItem.deleteMany({ where: { receiptId } });

    await tx.receiptItem.createMany({
      data: extraction.items.map((item, i) => ({
        receiptId,
        name: item.name,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
        sortOrder: i,
      })),
    });

    await tx.receipt.update({
      where: { id: receiptId },
      data: {
        status: 'COMPLETED',
        aiProvider: usedProvider.name,
        rawResponse: extraction as unknown as Prisma.InputJsonValue,
        extractedData: {
          merchantName: extraction.merchantName,
          date: normalizedDate,
          subtotal: extraction.subtotal,
          tax: extraction.tax,
          tip: extraction.tip,
          total: extraction.total,
          currency,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  });

  return {
    status: 'COMPLETED' as const,
    merchantName: extraction.merchantName,
    date: normalizedDate,
    subtotal: extraction.subtotal,
    tax: extraction.tax,
    tip: extraction.tip,
    total: extraction.total,
    currency,
    itemCount: extraction.items.length,
  };
}
