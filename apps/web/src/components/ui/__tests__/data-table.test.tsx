/**
 * KAN-988 — DataTable<T> row-click target-check regression.
 *
 * Visual smoke on PROD growth-web-00178-997 caught:
 *   - /opportunities All Deals: clicking the in-cell company <Link>
 *     navigated to the DEAL detail (row's onRowClick fired) instead of
 *     the COMPANY (Link's href). Both navigations fired; row push won.
 *   - Per-cell `onClick={(e) => e.stopPropagation()}` was in place on
 *     every Link/button author-side but didn't reliably halt the
 *     row-level synthetic click (Next.js <Link> in app-router).
 *
 * Defense moved to DataTable's row handler: skip onRowClick when the
 * click target sits inside any interactive descendant.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { DataTable, type DataTableColumn } from "../data-table";

type Row = { id: string; name: string; companyId: string };

const rows: Row[] = [
  { id: "d1", name: "E2E Test Deal", companyId: "c1" },
];

function buildColumns(): DataTableColumn<Row>[] {
  return [
    { id: "name", header: "Name", cell: (r) => <span>{r.name}</span> },
    {
      id: "company",
      header: "Company",
      cell: (r) => (
        <a href={`/companies/${r.companyId}`} data-testid="company-link">
          Acme Corp
        </a>
      ),
    },
  ];
}

describe("KAN-988 — DataTable row click target-check", () => {
  it("does NOT fire onRowClick when click originates inside an in-cell <a>", () => {
    const onRowClick = vi.fn();
    const { getByTestId } = render(
      <DataTable<Row>
        columns={buildColumns()}
        data={rows}
        getRowKey={(r) => r.id}
        searchValue=""
        onSearchChange={() => {}}
        hasMore={false}
        onLoadMore={() => {}}
        onRowClick={onRowClick}
      />,
    );
    fireEvent.click(getByTestId("company-link"));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("does NOT fire onRowClick when click originates inside an in-cell <button>", () => {
    const onRowClick = vi.fn();
    const columns: DataTableColumn<Row>[] = [
      { id: "name", header: "Name", cell: (r) => <span>{r.name}</span> },
      {
        id: "actions",
        header: "Actions",
        cell: () => (
          <button data-testid="row-action" type="button">
            Action
          </button>
        ),
      },
    ];
    const { getByTestId } = render(
      <DataTable<Row>
        columns={columns}
        data={rows}
        getRowKey={(r) => r.id}
        searchValue=""
        onSearchChange={() => {}}
        hasMore={false}
        onLoadMore={() => {}}
        onRowClick={onRowClick}
      />,
    );
    fireEvent.click(getByTestId("row-action"));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("DOES fire onRowClick on a plain row-body click (non-interactive cell content)", () => {
    const onRowClick = vi.fn();
    const { getByText } = render(
      <DataTable<Row>
        columns={[
          { id: "name", header: "Name", cell: (r) => <span>{r.name}</span> },
        ]}
        data={rows}
        getRowKey={(r) => r.id}
        searchValue=""
        onSearchChange={() => {}}
        hasMore={false}
        onLoadMore={() => {}}
        onRowClick={onRowClick}
      />,
    );
    fireEvent.click(getByText("E2E Test Deal"));
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);
  });

  it("skips onRowClick when click target is a descendant of an in-cell <a> (e.g., icon inside link)", () => {
    const onRowClick = vi.fn();
    const columns: DataTableColumn<Row>[] = [
      {
        id: "name",
        header: "Name",
        cell: (r) => (
          <a href={`/x/${r.id}`}>
            <span data-testid="nested-icon">→</span>
            <span>{r.name}</span>
          </a>
        ),
      },
    ];
    const { getByTestId } = render(
      <DataTable<Row>
        columns={columns}
        data={rows}
        getRowKey={(r) => r.id}
        searchValue=""
        onSearchChange={() => {}}
        hasMore={false}
        onLoadMore={() => {}}
        onRowClick={onRowClick}
      />,
    );
    fireEvent.click(getByTestId("nested-icon"));
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
