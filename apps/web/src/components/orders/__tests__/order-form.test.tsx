/**
 * KAN-945 — Sub-cohort 3.4 OrderForm tests.
 *
 * Coverage (14 tests) — Phase 4 acceptance:
 *   1. Renders all 5 cards + key fields in create mode
 *   2. Renders pre-populated fields in edit mode (orderToFormValues)
 *   3. Q8: orderNumber is read-only on edit (disabled input)
 *   4. Save disabled initially (isDirty=false)
 *   5. Save enables on first change
 *   6. Validation: empty orderNumber + Save → required error
 *   7. Validation: missing contact + Save → required error
 *   8. Q6.1 — LOAD-BEARING: edit non-date field → placedAt OMITTED from update payload
 *   9. Q6.2 — TZ-safe pre-pop: timestamp "2026-12-31T23:30:00.000Z" → date input shows "2026-12-31" (UTC day, not local)
 *  10. Q7 — Computed total hint shows totalAmount + tax − discount
 *  11. Create mode: Save → ordersApi.create called with cleaned payload
 *  12. Edit mode: Save → ordersApi.update called with id + diff payload
 *  13. Server error → toast.error + inline banner (KAN-942 standard)
 *  14. Q8 friendly duplicate-orderNumber error message displays verbatim
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrderForm, orderToFormValues } from '../order-form';
import type { OrderDetail } from '@/lib/api';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
  useParams: () => ({ id: 'ord-1' }),
}));

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

const createMock = vi.fn();
const updateMock = vi.fn();
const contactsListMock = vi
  .fn()
  .mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
const companiesListMock = vi
  .fn()
  .mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 });
const dealsListMock = vi
  .fn()
  .mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 });

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    ordersApi: {
      ...actual.ordersApi,
      create: (...args: unknown[]) => createMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
    },
    contactsApi: {
      ...actual.contactsApi,
      list: (...args: unknown[]) => contactsListMock(...args),
    },
    companiesApi: {
      ...actual.companiesApi,
      list: (...args: unknown[]) => companiesListMock(...args),
    },
    dealsApi: {
      ...actual.dealsApi,
      list: (...args: unknown[]) => dealsListMock(...args),
    },
  };
});

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

// KAN-945 — Q6.1 LOAD-BEARING fixture. placedAt is NOT midnight; it's a
// webhook-sourced timestamp with time-of-day precision. The test below
// asserts this timestamp is byte-for-byte preserved across an edit that
// touches only non-date fields.
const WEBHOOK_PLACED_AT_ISO = '2026-05-10T19:30:00.000Z';

// KAN-945 — Q6.2 day-boundary fixture. In TZs west of UTC, this timestamp
// renders as Dec 31 evening locally. The form's pre-population must use
// UTC parts (slice(0, 10)) → "2026-12-31", NOT the local day.
const DAY_BOUNDARY_PAID_AT_ISO = '2026-12-31T23:30:00.000Z';

const SAMPLE_ORDER: OrderDetail = {
  id: 'ord-1',
  orderNumber: 'ORD-2026-0001',
  status: 'paid',
  totalAmount: '100.00',
  taxAmount: '8.50',
  discountAmount: '0.00',
  grandTotal: '108.50',
  currency: 'USD',
  placedAt: WEBHOOK_PLACED_AT_ISO,
  paidAt: DAY_BOUNDARY_PAID_AT_ISO,
  refundedAt: null,
  cancelledAt: null,
  paymentMethod: 'card',
  paymentProvider: 'stripe',
  source: 'manual',
  contactId: 'ct_1',
  companyId: 'co_1',
  dealId: null,
  providerOrderId: 'ch_test_abc123',
  providerData: null,
  attributionFirstSource: 'organic_search',
  attributionLastSource: 'direct',
  customerNotes: 'original customer note',
  internalNotes: 'original internal',
  lineItems: [],
  externalIds: {},
  customFields: {},
  aiContext: {},
  correlationId: null,
  createdAt: '2026-05-10T19:00:00.000Z',
  updatedAt: '2026-05-10T19:00:00.000Z',
  contact: {
    id: 'ct_1',
    email: 'alice@acme.com',
    firstName: 'Alice',
    lastName: 'Test',
    companyId: 'co_1',
    companyName: 'Acme Inc',
  },
  // CompanyDetail-shaped — minimal subset for type compat.
  company: null,
  deal: null,
};

describe('KAN-945 — OrderForm', () => {
  beforeEach(() => {
    createMock.mockReset();
    updateMock.mockReset();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
  });

  it('(1) renders all 5 cards + key fields in create mode', () => {
    renderWithProviders(<OrderForm mode="create" />);
    expect(screen.getByText('Core Order')).toBeInTheDocument();
    expect(screen.getByText('Money')).toBeInTheDocument();
    expect(screen.getByText(/payment.*timeline/i)).toBeInTheDocument();
    expect(screen.getByText('Relationships')).toBeInTheDocument();
    expect(screen.getByText(/attribution.*notes/i)).toBeInTheDocument();
    // Sample required + key fields
    expect(screen.getByLabelText(/order number/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/total amount/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/grand total/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/placed at/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/currency/i)).toBeInTheDocument();
  });

  it('(2) renders pre-populated fields in edit mode', () => {
    renderWithProviders(
      <OrderForm
        mode="edit"
        orderId="ord-1"
        initialValues={orderToFormValues(SAMPLE_ORDER)}
        initialContactLabel="Alice Test <alice@acme.com>"
      />,
    );
    expect((screen.getByLabelText(/order number/i) as HTMLInputElement).value).toBe(
      'ORD-2026-0001',
    );
    expect((screen.getByLabelText(/currency/i) as HTMLInputElement).value).toBe('USD');
    expect((screen.getByLabelText(/provider order id/i) as HTMLInputElement).value).toBe(
      'ch_test_abc123',
    );
  });

  it('(3) Q8: orderNumber is read-only on edit (disabled input)', () => {
    renderWithProviders(
      <OrderForm
        mode="edit"
        orderId="ord-1"
        initialValues={orderToFormValues(SAMPLE_ORDER)}
        initialContactLabel="Alice"
      />,
    );
    const ordNumInput = screen.getByLabelText(/order number/i) as HTMLInputElement;
    expect(ordNumInput).toBeDisabled();
    // Helper-text hint visible
    expect(
      screen.getByText(/order number is read-only on edit/i),
    ).toBeInTheDocument();
  });

  it('(4) Save button disabled initially', () => {
    renderWithProviders(<OrderForm mode="create" />);
    expect(screen.getByRole('button', { name: /^create$/i })).toBeDisabled();
  });

  it('(5) Save button enables on first field change', () => {
    renderWithProviders(<OrderForm mode="create" />);
    fireEvent.change(screen.getByLabelText(/order number/i), {
      target: { value: 'ORD-1' },
    });
    expect(screen.getByRole('button', { name: /^create$/i })).not.toBeDisabled();
  });

  it('(6) Validation: empty orderNumber + Save → required error', () => {
    renderWithProviders(<OrderForm mode="create" />);
    // Dirty via currency change so Save enables; leave orderNumber empty.
    fireEvent.change(screen.getByLabelText(/currency/i), { target: { value: 'CAD' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    expect(screen.getByText(/order number is required/i)).toBeInTheDocument();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('(7) Validation: missing contact + Save → required error', () => {
    renderWithProviders(<OrderForm mode="create" />);
    fireEvent.change(screen.getByLabelText(/order number/i), {
      target: { value: 'ORD-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    expect(screen.getByText(/contact is required/i)).toBeInTheDocument();
    expect(createMock).not.toHaveBeenCalled();
  });

  // KAN-945 Q6.1 LOAD-BEARING — Edit a non-date field. The update payload
  // MUST NOT contain placedAt (or any unchanged date field). Combined with
  // the backend's `if (input.placedAt !== undefined)` guard, this preserves
  // the webhook-sourced timestamp byte-for-byte.
  it('(8) Q6.1: edit non-date field → date fields OMITTED from update payload', async () => {
    updateMock.mockResolvedValue(SAMPLE_ORDER);
    renderWithProviders(
      <OrderForm
        mode="edit"
        orderId="ord-1"
        initialValues={orderToFormValues(SAMPLE_ORDER)}
        initialContactLabel="Alice"
      />,
    );
    // User edits ONLY internalNotes — no date fields touched.
    fireEvent.change(screen.getByLabelText(/internal notes/i), {
      target: { value: 'updated internal note' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledOnce());
    const payload = updateMock.mock.calls[0]![0];
    // Critical: placedAt + paidAt + refundedAt + cancelledAt MUST be absent.
    expect(payload).not.toHaveProperty('placedAt');
    expect(payload).not.toHaveProperty('paidAt');
    expect(payload).not.toHaveProperty('refundedAt');
    expect(payload).not.toHaveProperty('cancelledAt');
    // internalNotes IS present.
    expect(payload.internalNotes).toBe('updated internal note');
    // id is present.
    expect(payload.id).toBe('ord-1');
  });

  // KAN-945 Q6.2 — TZ-safe pre-population. The `paidAt` ISO `2026-12-31T23:30:00.000Z`
  // is Dec 31 in UTC but Dec 31 evening in EDT (UTC-4). The form must show
  // "2026-12-31" (UTC day) in the date input — extracted via `iso.slice(0, 10)`
  // — NOT the local-shifted day.
  it('(9) Q6.2: day-boundary timestamp pre-populates as UTC day in date input', () => {
    renderWithProviders(
      <OrderForm
        mode="edit"
        orderId="ord-1"
        initialValues={orderToFormValues(SAMPLE_ORDER)}
        initialContactLabel="Alice"
      />,
    );
    const paidAtInput = screen.getByLabelText(/paid at/i) as HTMLInputElement;
    // UTC day from the fixture ISO `2026-12-31T23:30:00.000Z`
    expect(paidAtInput.value).toBe('2026-12-31');
    // placedAt fixture is `2026-05-10T19:30:00.000Z` — UTC day = 2026-05-10
    const placedAtInput = screen.getByLabelText(/placed at/i) as HTMLInputElement;
    expect(placedAtInput.value).toBe('2026-05-10');
  });

  // KAN-945 Q7 — Computed total hint visible below grandTotal field
  // when money fields populated.
  it('(10) Q7: computed total hint displays totalAmount + tax − discount', () => {
    renderWithProviders(
      <OrderForm
        mode="edit"
        orderId="ord-1"
        initialValues={orderToFormValues(SAMPLE_ORDER)}
        initialContactLabel="Alice"
      />,
    );
    // SAMPLE_ORDER: total 100.00, tax 8.50, discount 0.00 → 108.50
    expect(
      screen.getByText(/computed.*108\.50.*USD/i),
    ).toBeInTheDocument();
  });

  it('(11) Create mode: Save invokes ordersApi.create with cleaned payload', async () => {
    createMock.mockResolvedValue({ ...SAMPLE_ORDER, id: 'ord-new' });
    renderWithProviders(
      <OrderForm
        mode="create"
        initialValues={{
          orderNumber: 'ORD-NEW',
          status: 'pending',
          source: 'manual',
          totalAmount: '50.00',
          taxAmount: null,
          discountAmount: null,
          grandTotal: '50.00',
          currency: 'USD',
          paymentMethod: '',
          paymentProvider: '',
          providerOrderId: '',
          placedAt: '2026-05-20',
          paidAt: '',
          refundedAt: '',
          cancelledAt: '',
          contactId: 'ct_1',
          companyId: null,
          dealId: null,
          attributionFirstSource: '',
          attributionLastSource: '',
          customerNotes: '',
          internalNotes: '',
        }}
        initialContactLabel="Alice"
      />,
    );
    // Dirty the form so Save enables
    fireEvent.change(screen.getByLabelText(/order number/i), {
      target: { value: 'ORD-NEW-EDITED' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    await waitFor(() => expect(createMock).toHaveBeenCalledOnce());
    const payload = createMock.mock.calls[0]![0];
    expect(payload.orderNumber).toBe('ORD-NEW-EDITED');
    expect(payload.contactId).toBe('ct_1');
    expect(payload.totalAmount).toBe('50.00');
    expect(payload.placedAt).toBe('2026-05-20');
    // Empty optional fields → null
    expect(payload.paidAt).toBeNull();
    expect(payload.providerOrderId).toBeNull();
  });

  it('(12) Edit mode: Save invokes ordersApi.update with id + diff', async () => {
    updateMock.mockResolvedValue(SAMPLE_ORDER);
    renderWithProviders(
      <OrderForm
        mode="edit"
        orderId="ord-1"
        initialValues={orderToFormValues(SAMPLE_ORDER)}
        initialContactLabel="Alice"
      />,
    );
    fireEvent.change(screen.getByLabelText(/customer notes/i), {
      target: { value: 'edited customer note' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledOnce());
    const payload = updateMock.mock.calls[0]![0];
    expect(payload.id).toBe('ord-1');
    expect(payload.customerNotes).toBe('edited customer note');
    // Unchanged fields are NOT in the payload (diff-style update)
    expect(payload).not.toHaveProperty('orderNumber');
    expect(payload).not.toHaveProperty('totalAmount');
    expect(payload).not.toHaveProperty('contactId');
  });

  // KAN-942 standard: server error surfaces BOTH toast + inline banner.
  it('(13) Server error → toast.error + inline banner both fire', async () => {
    createMock.mockRejectedValue(new Error('Tenant quota exceeded'));
    renderWithProviders(
      <OrderForm
        mode="create"
        initialValues={{
          ...orderToFormValues(SAMPLE_ORDER),
          orderNumber: 'ORD-NEW',
          contactId: 'ct_1',
        }}
        initialContactLabel="Alice"
      />,
    );
    // Dirty so Save enables
    fireEvent.change(screen.getByLabelText(/order number/i), {
      target: { value: 'ORD-NEW-2' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    await waitFor(() => expect(createMock).toHaveBeenCalledOnce());
    await waitFor(() => {
      expect(screen.getByText(/tenant quota exceeded/i)).toBeInTheDocument();
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringMatching(/tenant quota exceeded/i),
    );
  });

  // KAN-945 Q8 — Friendly duplicate-orderNumber error from backend
  // surfaces verbatim in toast + banner (the backend wraps Prisma P2002 →
  // BAD_REQUEST with this exact message).
  it('(14) Q8: friendly duplicate-orderNumber error displays verbatim', async () => {
    createMock.mockRejectedValue(
      new Error('Order number already exists. Pick a different number.'),
    );
    renderWithProviders(
      <OrderForm
        mode="create"
        initialValues={{
          ...orderToFormValues(SAMPLE_ORDER),
          orderNumber: 'ORD-DUP',
          contactId: 'ct_1',
        }}
        initialContactLabel="Alice"
      />,
    );
    fireEvent.change(screen.getByLabelText(/order number/i), {
      target: { value: 'ORD-DUP-EDITED' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    await waitFor(() => expect(createMock).toHaveBeenCalledOnce());
    await waitFor(() => {
      expect(
        screen.getByText(/order number already exists/i),
      ).toBeInTheDocument();
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringMatching(/order number already exists/i),
    );
  });
});
