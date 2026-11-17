import { test, expect, type Page } from '@playwright/test';
import {
  users,
  login,
  authedContext,
  createTestGroup,
  trpcMutation,
  trpcQuery,
  trpcResult,
  trpcError,
  FAKE_JPEG,
} from './helpers';

// Once an expense is made from a receipt, the receipt can't be changed: not its items, prices, tax,
// tip or currency, and it isn't scanned again. That holds after the expense is deleted (restoring it
// brings it back as it was) and in an archived group. The expense is what gets corrected.

type Ctx = Awaited<ReturnType<typeof authedContext>>;
type Item = { id: string; totalPrice: number };

async function scanReceipt(owner: Ctx, groupId: string): Promise<string> {
  const uploadRes = await owner.post('/api/upload', {
    multipart: { file: { name: 'receipt.jpg', mimeType: 'image/jpeg', buffer: FAKE_JPEG } },
  });
  const { receiptId } = await uploadRes.json();
  const processed = await (await trpcMutation(owner, 'receipts.processReceipt', { receiptId, groupId }, 60_000)).json();
  expect(processed.result, JSON.stringify(processed)).toBeDefined();
  return receiptId;
}

async function receiptState(owner: Ctx, receiptId: string) {
  const { receipt, items } = await trpcResult(await trpcQuery(owner, 'receipts.getReceiptItems', { receiptId }));
  return {
    locked: receipt.locked as boolean,
    status: receipt.status as string,
    extractedData: receipt.extractedData,
    items: (items as (Item & { name: string; quantity: number })[]).map(({ id, name, quantity, totalPrice }) => ({
      id,
      name,
      quantity,
      totalPrice,
    })),
  };
}

async function createExpense(owner: Ctx, groupId: string, receiptId: string, payerId: string) {
  const { items } = await trpcResult(await trpcQuery(owner, 'receipts.getReceiptItems', { receiptId }));
  const res = await trpcMutation(owner, 'receipts.assignItemsAndCreateExpense', {
    groupId,
    receiptId,
    title: 'Groceries',
    paidById: payerId,
    assignments: (items as Item[]).map((item) => ({ receiptItemId: item.id, userIds: [payerId] })),
  });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()).result.data.json as { id: string; amount: number };
}

/** Every change the receipt page (or an API caller) can make, each expected to be refused */
async function tryEveryChange(owner: Ctx, receiptId: string) {
  const { items } = await trpcResult(await trpcQuery(owner, 'receipts.getReceiptItems', { receiptId }));
  const first = (items as Item[])[0]!;
  const attempts = {
    updateItem: await trpcMutation(owner, 'receipts.updateItem', {
      itemId: first.id,
      totalPrice: first.totalPrice + 100,
    }),
    addItem: await trpcMutation(owner, 'receipts.addItem', {
      receiptId,
      name: 'Extra',
      unitPrice: 100,
      totalPrice: 100,
    }),
    deleteItem: await trpcMutation(owner, 'receipts.deleteItem', { itemId: first.id }),
    splitItem: await trpcMutation(owner, 'receipts.splitItem', { itemId: first.id, splitQuantity: 1 }),
    updateExtractedData: await trpcMutation(owner, 'receipts.updateExtractedData', { receiptId, tax: 1, tip: 300 }),
    setCurrency: await trpcMutation(owner, 'receipts.setCurrency', { receiptId, currency: 'EUR' }),
    processReceipt: await trpcMutation(owner, 'receipts.processReceipt', { receiptId }, 60_000),
    retryProcessing: await trpcMutation(owner, 'receipts.retryProcessing', { receiptId }, 60_000),
  };
  const outcomes: Record<string, string | null> = {};
  for (const [name, res] of Object.entries(attempts)) {
    outcomes[name] = res.ok() ? 'ACCEPTED' : ((await trpcError(res))?.data?.messageKey ?? null);
  }
  return outcomes;
}

function expectAllRefused(outcomes: Record<string, string | null>, key: string) {
  for (const [name, outcome] of Object.entries(outcomes)) {
    // splitItem refuses a one-of item on its own before the lock; anything but ACCEPTED is a refusal
    expect(outcome, name).not.toBe('ACCEPTED');
    if (name !== 'splitItem') expect(outcome, name).toBe(key);
  }
}

test.describe('Receipt locked once its expense exists (API)', () => {
  test('every change is refused after the expense is created, after it is deleted, and after it is restored', async () => {
    const g = await createTestGroup(users.alice.email, users.alice.password, [], `Receipt-lock-${Date.now()}`);
    try {
      const aliceId = g.memberIds[users.alice.email]!;
      const receiptId = await scanReceipt(g.owner, g.groupId);
      const pending = await receiptState(g.owner, receiptId);
      expect(pending.locked).toBe(false);

      const expense = await createExpense(g.owner, g.groupId, receiptId, aliceId);
      const used = await receiptState(g.owner, receiptId);
      expect(used.locked).toBe(true);
      expectAllRefused(await tryEveryChange(g.owner, receiptId), 'receiptAlreadyHasExpense');
      expect(await receiptState(g.owner, receiptId)).toEqual(used);

      expect((await trpcMutation(g.owner, 'expenses.delete', { groupId: g.groupId, expenseId: expense.id })).ok()).toBe(
        true,
      );
      expectAllRefused(await tryEveryChange(g.owner, receiptId), 'receiptAlreadyHasExpense');
      expect(await receiptState(g.owner, receiptId)).toEqual(used);

      expect(
        (await trpcMutation(g.owner, 'expenses.restore', { groupId: g.groupId, expenseId: expense.id })).ok(),
      ).toBe(true);
      expectAllRefused(await tryEveryChange(g.owner, receiptId), 'receiptAlreadyHasExpense');
      expect(await receiptState(g.owner, receiptId)).toEqual(used);

      const restored = await trpcResult(
        await trpcQuery(g.owner, 'expenses.get', { groupId: g.groupId, expenseId: expense.id }),
      );
      expect(restored.amount).toBe(expense.amount);
    } finally {
      await g.dispose();
    }
  });

  test('a receipt with no expense stays editable', async () => {
    const g = await createTestGroup(users.alice.email, users.alice.password, [], `Receipt-pending-${Date.now()}`);
    try {
      const receiptId = await scanReceipt(g.owner, g.groupId);
      const { items } = await receiptState(g.owner, receiptId);
      const res = await trpcMutation(g.owner, 'receipts.updateItem', { itemId: items[0]!.id, totalPrice: 1234 });
      expect(res.ok(), await res.text()).toBe(true);
      const add = await trpcMutation(g.owner, 'receipts.updateExtractedData', { receiptId, tip: 200 });
      expect(add.ok()).toBe(true);
      expect((await receiptState(g.owner, receiptId)).items[0]!.totalPrice).toBe(1234);
    } finally {
      await g.dispose();
    }
  });

  test('a receipt in an archived group is refused too', async () => {
    const g = await createTestGroup(users.alice.email, users.alice.password, [], `Receipt-archived-${Date.now()}`);
    try {
      const receiptId = await scanReceipt(g.owner, g.groupId);
      expect((await trpcMutation(g.owner, 'groups.archive', { groupId: g.groupId })).ok()).toBe(true);
      const before = await receiptState(g.owner, receiptId);
      expect(before.locked).toBe(true);
      const outcomes = await tryEveryChange(g.owner, receiptId);
      expectAllRefused(outcomes, 'archivedEditExpense');
      expect(await receiptState(g.owner, receiptId)).toEqual(before);
      await trpcMutation(g.owner, 'groups.unarchive', { groupId: g.groupId });
    } finally {
      await g.dispose();
    }
  });

  test('an item edit racing Create Expense never leaves the expense out of step with its receipt', async () => {
    const g = await createTestGroup(users.alice.email, users.alice.password, [], `Receipt-race-${Date.now()}`);
    try {
      const aliceId = g.memberIds[users.alice.email]!;
      for (let run = 0; run < 8; run++) {
        const receiptId = await scanReceipt(g.owner, g.groupId);
        const { items, extractedData } = await receiptState(g.owner, receiptId);
        const [edit] = await Promise.all([
          trpcMutation(g.owner, 'receipts.updateItem', {
            itemId: items[0]!.id,
            totalPrice: items[0]!.totalPrice + 500,
          }),
          createExpense(g.owner, g.groupId, receiptId, aliceId),
        ]);
        const after = await receiptState(g.owner, receiptId);
        const { expenses } = await trpcResult(
          await trpcQuery(g.owner, 'expenses.list', { groupId: g.groupId, limit: 1 }),
        );
        const receiptTotal =
          after.items.reduce((sum, item) => sum + item.totalPrice, 0) + extractedData.tax + extractedData.tip;
        expect(expenses[0].amount, `run ${run}: edit ${edit.ok() ? 'landed first' : 'refused'}`).toBe(receiptTotal);
      }
    } finally {
      await g.dispose();
    }
  });
});

test.describe('Receipt locked once its expense exists (receipt page)', () => {
  async function openReceipt(page: Page, groupId: string, receiptId: string) {
    await login(page, users.alice.email, users.alice.password);
    await page.goto(`/en/groups/${groupId}/scan?receiptId=${receiptId}`);
    await expect(page.getByTestId('item-assignment-form')).toBeVisible({ timeout: 30000 });
  }

  test('a receipt with an expense opens read-only, and can still be viewed', async ({ page }) => {
    const g = await createTestGroup(users.alice.email, users.alice.password, [], `Receipt-page-${Date.now()}`);
    try {
      const aliceId = g.memberIds[users.alice.email]!;
      const receiptId = await scanReceipt(g.owner, g.groupId);
      await createExpense(g.owner, g.groupId, receiptId, aliceId);
      await openReceipt(page, g.groupId, receiptId);

      await expect(page.getByTestId('receipt-locked')).toBeVisible();
      await expect(page.getByTestId('split-all-btn')).toBeDisabled();
      await expect(page.getByTestId('add-item-btn')).toBeDisabled();
      await expect(page.getByTestId('create-expense-btn')).toBeDisabled();
      await expect(page.getByTestId('save-for-later-btn')).toBeDisabled();
      await expect(page.getByTestId('receipt-currency-select')).toBeDisabled();
      await expect(page.getByTestId(`member-toggle-${aliceId}`).first()).toBeDisabled();
      // Viewing stays available: the image toggle sits outside the read-only part
      await page.getByRole('button', { name: 'View Receipt Image' }).click();
      await expect(page.getByRole('img', { name: 'Receipt', exact: true })).toBeVisible();
    } finally {
      await g.dispose();
    }
  });

  test('a pending receipt opens editable', async ({ page }) => {
    const g = await createTestGroup(users.alice.email, users.alice.password, [], `Receipt-page-open-${Date.now()}`);
    try {
      const receiptId = await scanReceipt(g.owner, g.groupId);
      await openReceipt(page, g.groupId, receiptId);
      await expect(page.getByTestId('receipt-locked')).toBeHidden();
      await expect(page.getByTestId('split-all-btn')).toBeEnabled();
      await expect(page.getByTestId('add-item-btn')).toBeEnabled();
    } finally {
      await g.dispose();
    }
  });
});
