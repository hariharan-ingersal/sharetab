import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockGetAIProvidersWithFallback = vi.fn();
const mockClearProviderCache = vi.fn();

vi.mock('../ai/registry', () => ({
  getAIProvidersWithFallback: mockGetAIProvidersWithFallback,
  clearProviderCache: mockClearProviderCache,
}));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./normalize-date', () => ({
  normalizeDate: (value: string | undefined) => value,
}));

vi.mock('./upload-dir', () => ({
  getUploadDir: () => '/tmp/uploads',
  resolveUploadPath: (relativePath: string) => `/tmp/uploads/${relativePath}`,
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from('fake-image')),
}));

describe('processReceiptImage fallback behavior', () => {
  beforeEach(() => {
    vi.resetModules();
    mockGetAIProvidersWithFallback.mockReset();
    mockClearProviderCache.mockReset();
  });

  function makeDbMock() {
    const db = {
      receiptItem: {
        deleteMany: vi.fn().mockResolvedValue(undefined),
        createMany: vi.fn().mockResolvedValue(undefined),
      },
      receipt: {
        update: vi.fn().mockResolvedValue(undefined),
      },
      // The receipt's row, locked before its items are replaced; no expense made from it
      $queryRaw: vi.fn().mockResolvedValue([{ groupId: null }]),
      expense: { findUnique: vi.fn().mockResolvedValue(null) },
      group: { findUnique: vi.fn().mockResolvedValue(null) },
      // Interactive transaction: run the callback against the same mock
      $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    };
    return db;
  }

  const successResult = {
    merchantName: 'Store',
    date: '2026-04-13',
    subtotal: 1000,
    tax: 80,
    tip: 0,
    total: 1080,
    currency: 'USD',
    items: [{ name: 'Item', quantity: 1, unitPrice: 1080, totalPrice: 1080 }],
  };

  test('falls back to next provider when first extraction fails', async () => {
    const provider1 = {
      name: 'openai-codex',
      extractReceipt: vi.fn().mockRejectedValue(new Error('expired')),
    };
    const provider2 = {
      name: 'openai',
      extractReceipt: vi.fn().mockResolvedValue(successResult),
    };
    mockGetAIProvidersWithFallback.mockResolvedValue([provider1, provider2]);

    const { processReceiptImage } = await import('./receipt-processor');
    const db = makeDbMock();

    await processReceiptImage({
      db: db as never,
      receiptId: 'r1',
      receipt: { imagePath: 'r1.jpg', mimeType: 'image/jpeg' },
      fallbackCurrency: 'USD',
    });

    expect(provider1.extractReceipt).toHaveBeenCalledTimes(1);
    expect(provider2.extractReceipt).toHaveBeenCalledTimes(1);
    expect(db.receipt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ aiProvider: 'openai' }),
      }),
    );
    expect(mockClearProviderCache).not.toHaveBeenCalled();
  });

  test('clears provider cache and retries provider list on first full-pass failure', async () => {
    const badProvider = {
      name: 'openai-codex',
      extractReceipt: vi.fn().mockRejectedValue(new Error('auth expired')),
    };
    const recoveredProvider = {
      name: 'openai-codex',
      extractReceipt: vi.fn().mockResolvedValue(successResult),
    };

    mockGetAIProvidersWithFallback.mockResolvedValueOnce([badProvider]).mockResolvedValueOnce([recoveredProvider]);

    const { processReceiptImage } = await import('./receipt-processor');
    const db = makeDbMock();

    await processReceiptImage({
      db: db as never,
      receiptId: 'r2',
      receipt: { imagePath: 'r2.jpg', mimeType: 'image/jpeg' },
      fallbackCurrency: 'USD',
    });

    expect(mockGetAIProvidersWithFallback).toHaveBeenCalledTimes(2);
    expect(mockClearProviderCache).toHaveBeenCalledTimes(1);
    expect(recoveredProvider.extractReceipt).toHaveBeenCalledTimes(1);
  });

  test('throws after both fallback passes fail', async () => {
    const badProvider = {
      name: 'openai-codex',
      extractReceipt: vi.fn().mockRejectedValue(new Error('still expired')),
    };
    mockGetAIProvidersWithFallback.mockResolvedValue([badProvider]);

    const { processReceiptImage } = await import('./receipt-processor');
    const db = makeDbMock();

    await expect(
      processReceiptImage({
        db: db as never,
        receiptId: 'r3',
        receipt: { imagePath: 'r3.jpg', mimeType: 'image/jpeg' },
        fallbackCurrency: 'USD',
      }),
    ).rejects.toThrow('Receipt extraction failed across configured providers');

    expect(mockClearProviderCache).toHaveBeenCalledTimes(1);
  });

  // #361: a receipt whose currency the model couldn't read was saved as USD
  describe('the currency saved', () => {
    async function scan(currency: string | undefined) {
      // The schema reads a currency the model didn't return as undefined
      const extraction = { ...successResult, currency };
      mockGetAIProvidersWithFallback.mockResolvedValue([
        { name: 'openai', extractReceipt: vi.fn().mockResolvedValue(extraction) },
      ]);
      const { processReceiptImage } = await import('./receipt-processor');
      const db = makeDbMock();
      const result = await processReceiptImage({
        db: db as never,
        receiptId: 'r4',
        receipt: { imagePath: 'r4.jpg', mimeType: 'image/jpeg' },
        fallbackCurrency: 'EUR',
      });
      const { data } = db.receipt.update.mock.calls[0]![0] as { data: { extractedData: { currency: string } } };
      return { saved: data.extractedData.currency, returned: result.currency };
    }

    test('is the fallback (the group currency) when the scan read none', async () => {
      expect(await scan(undefined)).toEqual({ saved: 'EUR', returned: 'EUR' });
    });

    test('is the one the scan read when it read one', async () => {
      expect(await scan('GBP')).toEqual({ saved: 'GBP', returned: 'GBP' });
    });
  });

  // A scan can outlive its claim (a stale one is claimed again after 15 minutes): if an expense was
  // made from the receipt meanwhile, its result is dropped and the receipt's items stay as they are
  test('a scan finishing after an expense was made from the receipt changes nothing', async () => {
    mockGetAIProvidersWithFallback.mockResolvedValue([
      { name: 'openai', extractReceipt: vi.fn().mockResolvedValue(successResult) },
    ]);
    const { processReceiptImage } = await import('./receipt-processor');
    const db = makeDbMock();
    db.expense.findUnique.mockResolvedValue({ id: 'e1' });

    await expect(
      processReceiptImage({
        db: db as never,
        receiptId: 'r1',
        receipt: { imagePath: 'r1.jpg', mimeType: 'image/jpeg' },
        fallbackCurrency: 'USD',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', messageKey: 'receiptAlreadyHasExpense' });
    expect(db.receiptItem.deleteMany).not.toHaveBeenCalled();
    expect(db.receiptItem.createMany).not.toHaveBeenCalled();
    expect(db.receipt.update).not.toHaveBeenCalled();
  });
});

describe('lockEditableReceipt', () => {
  function db({
    receipt = [{ groupId: 'g1' }],
    expense = null,
    group = { archivedAt: null },
  }: {
    receipt?: { groupId: string | null }[];
    expense?: { id: string } | null;
    group?: { archivedAt: Date | null } | null;
  } = {}) {
    return {
      $queryRaw: vi.fn().mockResolvedValue(receipt),
      expense: { findUnique: vi.fn().mockResolvedValue(expense) },
      group: { findUnique: vi.fn().mockResolvedValue(group) },
    };
  }
  const lock = async (tx: ReturnType<typeof db>) => {
    const { lockEditableReceipt } = await import('./receipt-processor');
    return lockEditableReceipt(tx as never, 'r1');
  };

  test('a receipt with no expense, in an active group, may be changed, once its row is locked', async () => {
    const tx = db();
    await expect(lock(tx)).resolves.toBeUndefined();
    const [strings] = tx.$queryRaw.mock.calls[0]!;
    expect((strings as string[]).join('?')).toMatch(/FROM "Receipt" WHERE "id" = \? FOR NO KEY UPDATE/);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.expense.findUnique.mock.invocationCallOrder[0]!);
  });

  test('one an expense was made from is refused: the lookup by receipt finds deleted expenses too', async () => {
    const tx = db({ expense: { id: 'e1' } });
    await expect(lock(tx)).rejects.toMatchObject({ code: 'BAD_REQUEST', messageKey: 'receiptAlreadyHasExpense' });
    // No deletedAt filter: restoring brings a deleted expense back as it was
    expect(tx.expense.findUnique).toHaveBeenCalledWith({ where: { receiptId: 'r1' }, select: { id: true } });
  });

  test('one in an archived group is refused', async () => {
    const tx = db({ group: { archivedAt: new Date() } });
    await expect(lock(tx)).rejects.toMatchObject({ code: 'BAD_REQUEST', messageKey: 'archivedEditExpense' });
  });

  test('one outside any group is judged by its expense alone', async () => {
    const tx = db({ receipt: [{ groupId: null }] });
    await expect(lock(tx)).resolves.toBeUndefined();
    expect(tx.group.findUnique).not.toHaveBeenCalled();
  });

  test('a receipt that is gone is NOT_FOUND', async () => {
    await expect(lock(db({ receipt: [] }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
