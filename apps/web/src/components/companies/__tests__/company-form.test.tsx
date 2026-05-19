/**
 * KAN-937 — Sub-cohort 3.2 CompanyForm tests.
 *
 * Coverage (10 tests):
 *   1. Renders all 5 cards + key fields in create mode (empty initial values)
 *   2. Renders pre-populated fields in edit mode (companyToFormValues)
 *   3. isDirty stays false on initial render (Save disabled)
 *   4. isDirty becomes true on first field change (Save enables)
 *   5. Name required validation: empty + Save → error displayed
 *   6. "Same as billing" button copies all 6 billing fields → mailing
 *   7. isTaxExempt=false → taxExemptionCertificate field NOT rendered
 *   8. isTaxExempt=true → taxExemptionCertificate field IS rendered
 *   9. Create mode: Save click invokes companiesApi.create with cleaned payload
 *  10. Edit mode: Save click invokes companiesApi.update with id + payload
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CompanyForm, companyToFormValues } from '../company-form';
import type { CompanyDetail } from '@/lib/api';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
  useParams: () => ({ id: 'co-1' }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const createMock = vi.fn();
const updateMock = vi.fn();
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    companiesApi: {
      ...actual.companiesApi,
      create: (...args: unknown[]) => createMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
    },
  };
});

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const SAMPLE_COMPANY: CompanyDetail = {
  id: 'co-1',
  name: 'Acme Inc',
  legalName: 'Acme Corporation',
  domain: 'acme.com',
  website: 'https://acme.com',
  industry: 'Manufacturing',
  sizeRange: 'range_51_200',
  annualRevenue: '12500000.00',
  description: 'Widget maker',
  lifecycleStage: 'customer',
  phone: '+1-555-0100',
  email: 'contact@acme.com',
  linkedinUrl: 'https://linkedin.com/company/acme',
  billingAddressLine1: '1 Acme Plaza',
  billingAddressLine2: 'Suite 100',
  billingCity: 'Boston',
  billingRegion: 'MA',
  billingPostalCode: '02101',
  billingCountry: 'US',
  mailingAddressLine1: 'PO Box 1',
  mailingAddressLine2: null,
  mailingCity: 'Boston',
  mailingRegion: 'MA',
  mailingPostalCode: '02102',
  mailingCountry: 'US',
  taxId: '12-3456789',
  taxIdType: 'ein',
  businessRegistrationNumber: 'BR-001',
  incorporationJurisdiction: 'Delaware',
  isTaxExempt: false,
  taxExemptionCertificate: null,
  ownerId: null,
  tags: [],
  externalIds: {},
  customFields: {},
  aiContext: {},
  deletedAt: null,
  _count: { contacts: 0, deals: 0, orders: 0 },
  contacts: [],
  deals: [],
  orders: [],
  createdAt: '2026-05-19T00:00:00Z',
  updatedAt: '2026-05-19T00:00:00Z',
};

describe('KAN-937 — CompanyForm', () => {
  beforeEach(() => {
    createMock.mockReset();
    updateMock.mockReset();
  });

  it('(1) renders all 5 cards + key fields in create mode', () => {
    renderWithProviders(<CompanyForm mode="create" />);
    // Card titles
    expect(screen.getByText('Core Info')).toBeInTheDocument();
    expect(screen.getByText('Contact Info')).toBeInTheDocument();
    expect(screen.getByText('Billing Address')).toBeInTheDocument();
    expect(screen.getByText('Mailing Address')).toBeInTheDocument();
    expect(screen.getByText(/tax.*compliance/i)).toBeInTheDocument();
    // Required field
    expect(screen.getByLabelText(/^name/i)).toBeInTheDocument();
    // Sampled fields across cards
    expect(screen.getByLabelText(/legal name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/domain/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/annual revenue/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/linkedin/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^tax id$/i)).toBeInTheDocument();
  });

  it('(2) renders pre-populated fields in edit mode', () => {
    renderWithProviders(
      <CompanyForm
        mode="edit"
        companyId="co-1"
        initialValues={companyToFormValues(SAMPLE_COMPANY)}
      />,
    );
    expect((screen.getByLabelText(/^name/i) as HTMLInputElement).value).toBe('Acme Inc');
    expect((screen.getByLabelText(/legal name/i) as HTMLInputElement).value).toBe(
      'Acme Corporation',
    );
    expect((screen.getByLabelText(/domain/i) as HTMLInputElement).value).toBe('acme.com');
  });

  it('(3) Save button disabled initially (isDirty=false)', () => {
    renderWithProviders(<CompanyForm mode="create" />);
    const saveBtn = screen.getByRole('button', { name: /^create$/i });
    expect(saveBtn).toBeDisabled();
  });

  it('(4) Save button enables after first field change', () => {
    renderWithProviders(<CompanyForm mode="create" />);
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'New Co' } });
    const saveBtn = screen.getByRole('button', { name: /^create$/i });
    expect(saveBtn).not.toBeDisabled();
  });

  it('(5) Name required: empty + Save → error banner', () => {
    renderWithProviders(<CompanyForm mode="create" />);
    // Dirty the form via domain so Save enables; leave name empty.
    fireEvent.change(screen.getByLabelText(/domain/i), { target: { value: 'foo.com' } });
    const saveBtn = screen.getByRole('button', { name: /^create$/i });
    fireEvent.click(saveBtn);
    expect(screen.getByText(/name is required/i)).toBeInTheDocument();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('(6) "Same as billing" copies all 6 billing fields → mailing', () => {
    const { container } = renderWithProviders(<CompanyForm mode="create" />);
    // Labels say "Address line 1" in both cards — disambiguate via input id.
    const byId = (id: string) =>
      container.querySelector(`#${id}`) as HTMLInputElement;
    fireEvent.change(byId('billingAddressLine1'), {
      target: { value: '1 Acme Plaza' },
    });
    fireEvent.change(byId('billingAddressLine2'), {
      target: { value: 'Suite 500' },
    });
    fireEvent.change(byId('billingCity'), { target: { value: 'Boston' } });
    fireEvent.change(byId('billingRegion'), { target: { value: 'MA' } });
    fireEvent.change(byId('billingPostalCode'), { target: { value: '02101' } });
    fireEvent.change(byId('billingCountry'), { target: { value: 'US' } });
    fireEvent.click(screen.getByRole('button', { name: /same as billing/i }));
    expect(byId('mailingAddressLine1').value).toBe('1 Acme Plaza');
    expect(byId('mailingAddressLine2').value).toBe('Suite 500');
    expect(byId('mailingCity').value).toBe('Boston');
    expect(byId('mailingRegion').value).toBe('MA');
    expect(byId('mailingPostalCode').value).toBe('02101');
    expect(byId('mailingCountry').value).toBe('US');
  });

  it('(7) isTaxExempt=false → taxExemptionCertificate field NOT rendered', () => {
    renderWithProviders(<CompanyForm mode="create" />);
    // Default isTaxExempt is false; certificate field must not exist.
    expect(screen.queryByLabelText(/tax exemption certificate/i)).not.toBeInTheDocument();
  });

  it('(8) isTaxExempt=true → taxExemptionCertificate field IS rendered', () => {
    renderWithProviders(<CompanyForm mode="create" />);
    // Toggle the Switch — Radix Switch surfaces as a button with role="switch"
    const switchEl = screen.getByRole('switch', { name: /tax-exempt/i });
    fireEvent.click(switchEl);
    expect(screen.getByLabelText(/tax exemption certificate/i)).toBeInTheDocument();
  });

  it('(9) Create mode: Save invokes companiesApi.create with cleaned payload', async () => {
    createMock.mockResolvedValue({ ...SAMPLE_COMPANY, id: 'co-new' });
    renderWithProviders(<CompanyForm mode="create" />);
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'New Globex' } });
    fireEvent.change(screen.getByLabelText(/domain/i), {
      target: { value: 'globex.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    await waitFor(() => expect(createMock).toHaveBeenCalledOnce());
    const payload = createMock.mock.calls[0]![0];
    expect(payload.name).toBe('New Globex');
    expect(payload.domain).toBe('globex.com');
    // Empty fields → null in payload (form-to-input cleaner)
    expect(payload.legalName).toBeNull();
    expect(payload.billingCity).toBeNull();
  });

  it('(10) Edit mode: Save invokes companiesApi.update with id + payload', async () => {
    updateMock.mockResolvedValue(SAMPLE_COMPANY);
    renderWithProviders(
      <CompanyForm
        mode="edit"
        companyId="co-1"
        initialValues={companyToFormValues(SAMPLE_COMPANY)}
      />,
    );
    fireEvent.change(screen.getByLabelText(/phone/i), {
      target: { value: '+1-555-0999' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledOnce());
    const payload = updateMock.mock.calls[0]![0];
    expect(payload.id).toBe('co-1');
    expect(payload.phone).toBe('+1-555-0999');
    expect(payload.name).toBe('Acme Inc');
  });
});
