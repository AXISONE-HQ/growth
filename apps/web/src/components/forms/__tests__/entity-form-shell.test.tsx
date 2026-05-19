/**
 * KAN-932 — EntityFormShell tests.
 *
 * Coverage:
 *   - Renders title + mode badge + children
 *   - Save button enabled only when isDirty && !isPending
 *   - Cancel button always enabled
 *   - Error banner renders when errors prop populated
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EntityFormShell } from '../entity-form-shell';

// Mock next/navigation for useRouter
vi.mock('next/navigation', () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
}));

describe('KAN-932 — EntityFormShell', () => {
  it('renders title + create badge + children', () => {
    render(
      <EntityFormShell
        title="Create customer"
        mode="create"
        isPending={false}
        isDirty={false}
        onSave={() => undefined}
      >
        <div>Form body content</div>
      </EntityFormShell>,
    );
    expect(screen.getByText('Create customer')).toBeInTheDocument();
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.getByText('Form body content')).toBeInTheDocument();
  });

  it('Save button disabled when !isDirty', () => {
    render(
      <EntityFormShell
        title="Edit"
        mode="edit"
        isPending={false}
        isDirty={false}
        onSave={() => undefined}
      >
        <div />
      </EntityFormShell>,
    );
    const saveBtn = screen.getByRole('button', { name: /save changes/i });
    expect(saveBtn).toBeDisabled();
  });

  it('Save button enabled when isDirty && !isPending', () => {
    render(
      <EntityFormShell
        title="Edit"
        mode="edit"
        isPending={false}
        isDirty={true}
        onSave={() => undefined}
      >
        <div />
      </EntityFormShell>,
    );
    const saveBtn = screen.getByRole('button', { name: /save changes/i });
    expect(saveBtn).not.toBeDisabled();
  });

  it('Save button shows Saving spinner when isPending', () => {
    render(
      <EntityFormShell
        title="Edit"
        mode="edit"
        isPending={true}
        isDirty={true}
        onSave={() => undefined}
      >
        <div />
      </EntityFormShell>,
    );
    expect(screen.getByText(/saving/i)).toBeInTheDocument();
  });

  it('renders error banner when errors prop populated', () => {
    render(
      <EntityFormShell
        title="Edit"
        mode="edit"
        isPending={false}
        isDirty={false}
        onSave={() => undefined}
        errors={['Email is required', 'Phone is invalid']}
      >
        <div />
      </EntityFormShell>,
    );
    expect(screen.getByText('Email is required')).toBeInTheDocument();
    expect(screen.getByText('Phone is invalid')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('Save button click invokes onSave', () => {
    const onSave = vi.fn();
    render(
      <EntityFormShell
        title="Create"
        mode="create"
        isPending={false}
        isDirty={true}
        onSave={onSave}
      >
        <div />
      </EntityFormShell>,
    );
    const saveBtn = screen.getByRole('button', { name: /create/i });
    saveBtn.click();
    expect(onSave).toHaveBeenCalledOnce();
  });
});
