"use client";

/**
 * KAN-1218 — /settings/products operator-facing UI surface.
 *
 * First UI consumer of the canonical productsRouter / productVariantsRouter /
 * productCategoriesRouter substrate landed in KAN-1213 / KAN-1216b/c/d. Also
 * consumes settingsRouter.{get,set}MarketingDomain (KAN-1217) to surface the
 * scraper-bootstrap CTA.
 *
 * SKU column REFUTE (KAN-1218 I3): SKU stays on the Product schema column
 * (live consumers at /opportunities/[id]:241 and /orders/[id]:207). This page
 * does NOT render or edit SKU — those views are out of scope; SKU is read
 * downstream through the schema column directly.
 *
 * Cursor pagination follows KAN-1183 canonical CursorPage<T> shape (status
 * filter chip strip + debounced 300ms search to mirror /campaigns).
 *
 * Category depth limit (MAX_CATEGORY_DEPTH=5) is service-layer-enforced per
 * KAN-1216d M3 doctrine — UI relies on CategoryDepthLimitExceededError
 * BAD_REQUEST surfacing.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Package, Trash2, Pencil, ChevronDown, ChevronRight, Globe, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  productsApi,
  productVariantsApi,
  productCategoriesApi,
  marketingDomainApi,
  type ProductListItem,
  type ProductVariantListItem,
  type ProductCategoryListItem,
  type ProductStatus,
  type CursorPage,
} from "@/lib/api";

/* ── Status filter — canonical ProductStatusEnum per KAN-1213 ─────────── */

const STATUS_FILTER_OPTIONS: Array<{ value: ProductStatus | null; label: string }> = [
  { value: null, label: "All" },
  { value: "draft", label: "Draft" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

const STATUS_LABEL: Record<ProductStatus, string> = {
  draft: "Draft",
  active: "Active",
  archived: "Archived",
};

function statusBadgeVariant(s: ProductStatus): "muted" | "green" | "rose" {
  if (s === "active") return "green";
  if (s === "archived") return "rose";
  return "muted";
}

function formatPrice(price: number | null, currency: string): string {
  if (price == null) return "—";
  return `${currency} ${price.toFixed(2)}`;
}

/* ── Top-level Page ──────────────────────────────────────────────────── */

export default function ProductsSettingsPage() {
  const [tab, setTab] = useState<"products" | "categories">("products");

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
        <p className="text-sm text-muted-foreground">
          Manage your product catalog, variants, and categories. The AI references these for pricing, descriptions, and recommendations.
        </p>
      </header>

      <MarketingDomainBanner />

      <div className="flex gap-2 border-b border-border">
        <button
          type="button"
          onClick={() => setTab("products")}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === "products" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Products
        </button>
        <button
          type="button"
          onClick={() => setTab("categories")}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === "categories" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Categories
        </button>
      </div>

      {tab === "products" ? <ProductsTab /> : <CategoriesTab />}
    </div>
  );
}

/* ── Marketing Domain CTA banner (Step 8) ────────────────────────────── */

function MarketingDomainBanner() {
  const [modalOpen, setModalOpen] = useState(false);
  const { data, refetch } = useQuery({
    queryKey: ["settings", "marketingDomain"],
    queryFn: () => marketingDomainApi.get(),
  });

  if (data?.marketingDomain) return null;

  return (
    <>
      <Card className="border-amber-200 bg-amber-50/50">
        <CardContent className="flex items-center justify-between gap-4 py-4">
          <div className="flex items-center gap-3">
            <AlertCircle className="h-5 w-5 text-amber-600" />
            <div>
              <p className="text-sm font-medium">Configure your marketing domain to enable product scraping</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Once set, the AI can scrape your product catalog automatically from your website.
              </p>
            </div>
          </div>
          <Button size="sm" onClick={() => setModalOpen(true)}>
            <Globe className="h-4 w-4" />
            Configure
          </Button>
        </CardContent>
      </Card>

      <MarketingDomainModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        onSaved={() => {
          setModalOpen(false);
          void refetch();
        }}
      />
    </>
  );
}

function MarketingDomainModal({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [domain, setDomain] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validUrl = (() => {
    if (!domain) return false;
    try {
      new URL(domain);
      return true;
    } catch {
      return false;
    }
  })();

  async function handleSave() {
    if (!validUrl) {
      setError("Please enter a valid URL (e.g. https://example.com)");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await marketingDomainApi.set(domain);
      toast.success("Marketing domain saved");
      onSaved();
    } catch (e) {
      setError((e as Error)?.message ?? "Failed to save marketing domain");
    }
    setSaving(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure marketing domain</DialogTitle>
          <DialogDescription>
            Enter your public marketing website URL. The AI uses this to scrape your product catalog.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor="marketing-domain">Website URL</Label>
          <Input
            id="marketing-domain"
            type="url"
            placeholder="https://example.com"
            value={domain}
            onChange={(e) => {
              setDomain(e.target.value);
              setError(null);
            }}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!validUrl || saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Products Tab (Steps 5 + 6) ──────────────────────────────────────── */

function ProductsTab() {
  const [searchInput, setSearchInput] = useState("");
  const [searchDebounced, setSearchDebounced] = useState("");
  const [statusFilter, setStatusFilter] = useState<ProductStatus | null>(null);
  const [pages, setPages] = useState<CursorPage<ProductListItem>[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ProductListItem | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: marketingDomain } = useQuery({
    queryKey: ["settings", "marketingDomain"],
    queryFn: () => marketingDomainApi.get(),
  });

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setPages([]);
  }, [searchDebounced, statusFilter]);

  const currentCursor = pages.length > 0 ? pages[pages.length - 1]?.nextCursor : null;

  const queryInput = useMemo(
    () => ({
      limit: 20,
      ...(currentCursor ? { cursor: currentCursor } : {}),
    }),
    [currentCursor],
  );

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<CursorPage<ProductListItem>>({
    queryKey: ["products", "list", queryInput, statusFilter, searchDebounced],
    queryFn: () => productsApi.list(queryInput),
  });

  useEffect(() => {
    if (!data) return;
    setPages((prev) => {
      if (prev.length === 0) return [data];
      const last = prev[prev.length - 1];
      if (last && last.nextCursor === data.nextCursor) return prev;
      return [...prev, data];
    });
  }, [data]);

  // Client-side filter: status + search. Server-side filter additions tracked
  // in productsRouter.list TODO (KAN-1216b Observation B); status/search local
  // for now is acceptable since pagination is per-page.
  const allItems = pages.flatMap((p) => p.items);
  const items = allItems.filter((p) => {
    if (statusFilter && p.status !== statusFilter) return false;
    if (searchDebounced) {
      const q = searchDebounced.toLowerCase();
      if (!p.name.toLowerCase().includes(q) && !(p.description ?? "").toLowerCase().includes(q)) return false;
    }
    return true;
  });
  const hasMore = (pages[pages.length - 1]?.nextCursor ?? data?.nextCursor) != null;

  async function handleArchive(p: ProductListItem) {
    if (!confirm(`Archive "${p.name}"? This hides it from active lists but preserves history.`)) return;
    try {
      await productsApi.archive(p.id);
      toast.success("Product archived");
      setPages([]);
      void refetch();
    } catch (e) {
      toast.error((e as Error)?.message ?? "Failed to archive product");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-1">
          <Input
            placeholder="Search products..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="max-w-sm"
          />
          <div className="flex gap-1">
            {STATUS_FILTER_OPTIONS.map((opt) => (
              <button
                key={opt.label}
                type="button"
                onClick={() => setStatusFilter(opt.value)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                  statusFilter === opt.value
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background text-muted-foreground border-border hover:bg-muted"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!marketingDomain?.marketingDomain}
            title={!marketingDomain?.marketingDomain ? "Configure marketing domain first to enable scraping" : "Scrape products from your website"}
            onClick={() => {
              // TODO(KAN-1219+): wire scrape mutation when scraper subscriber lands.
              toast.info("Scraping will be enabled in a future release");
            }}
          >
            <Globe className="h-4 w-4" />
            Scrape from website
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            Create product
          </Button>
        </div>
      </div>

      {isError && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-sm text-destructive">Couldn&apos;t load products</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-destructive/80">{(error as Error)?.message}</p>
          </CardContent>
        </Card>
      )}

      {isLoading && pages.length === 0 && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="h-16" />
            </Card>
          ))}
        </div>
      )}

      {!isLoading && items.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Package className="h-10 w-10 text-muted-foreground/50" />
            <div>
              <p className="text-sm font-medium">No products yet</p>
              <p className="text-xs text-muted-foreground mt-1">Click Create to add your first product</p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        {items.map((p) => (
          <div key={p.id} className="rounded-lg border bg-card">
            <div className="flex items-center justify-between p-4">
              <button
                type="button"
                onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
                className="flex items-center gap-3 text-left flex-1 hover:opacity-80"
              >
                {expandedId === p.id ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{p.name}</span>
                    <Badge variant={statusBadgeVariant(p.status)} className="text-xs">
                      {STATUS_LABEL[p.status]}
                    </Badge>
                    <span className="text-sm text-muted-foreground tabular-nums">{formatPrice(p.price, p.currency)}</span>
                  </div>
                  {p.description && <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{p.description}</p>}
                </div>
              </button>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}>
                  <Pencil className="h-4 w-4" />
                </Button>
                {p.status !== "archived" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleArchive(p)}
                    aria-label={`Archive ${p.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>

            {expandedId === p.id && (
              <div className="border-t bg-muted/30 p-4">
                <VariantsSection productId={p.id} parentPrice={p.price} currency={p.currency} />
              </div>
            )}
          </div>
        ))}
      </div>

      {hasMore && (
        <div className="flex justify-center pt-2">
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
            {isFetching ? "Loading..." : "Load more"}
          </Button>
        </div>
      )}

      <CreateProductModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setCreateOpen(false);
          setPages([]);
          void refetch();
        }}
      />

      <EditProductModal
        product={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSaved={() => {
          setEditing(null);
          setPages([]);
          void refetch();
        }}
      />
    </div>
  );
}

/* ── Variants Section (inline expansion) ─────────────────────────────── */

function VariantsSection({
  productId,
  parentPrice,
  currency,
}: {
  productId: string;
  parentPrice: number | null;
  currency: string;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const { data, isLoading, refetch } = useQuery<CursorPage<ProductVariantListItem>>({
    queryKey: ["productVariants", "list", productId],
    queryFn: () => productVariantsApi.list({ productId, limit: 50 }),
  });

  const items = data?.items ?? [];

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">Variants</h4>
        <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3 w-3" />
          Add Variant
        </Button>
      </div>

      {isLoading && <p className="text-xs text-muted-foreground">Loading variants...</p>}

      {!isLoading && items.length === 0 && (
        <p className="text-xs text-muted-foreground">No variants. Use variants to model size, color, or other product dimensions.</p>
      )}

      {items.length > 0 && (
        <div className="rounded border bg-background">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Attributes</th>
                <th className="px-3 py-2 font-medium">Price</th>
                <th className="px-3 py-2 font-medium">Effective</th>
              </tr>
            </thead>
            <tbody>
              {items.map((v) => (
                <tr key={v.id} className="border-b last:border-0">
                  <td className="px-3 py-2">
                    <code className="text-xs">{JSON.stringify(v.attributes)}</code>
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {v.price == null ? <span className="text-muted-foreground italic">inherit</span> : formatPrice(v.price, currency)}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{formatPrice(v.effectivePrice, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateVariantModal
        productId={productId}
        parentPrice={parentPrice}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setCreateOpen(false);
          void refetch();
        }}
      />
    </div>
  );
}

/* ── Create / Edit Product Modals (Step 6) ───────────────────────────── */

interface ProductDraft {
  name: string;
  description: string;
  status: ProductStatus;
  price: string;
  currency: string;
}

function emptyDraft(): ProductDraft {
  return { name: "", description: "", status: "draft", price: "", currency: "USD" };
}

function CreateProductModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [draft, setDraft] = useState<ProductDraft>(emptyDraft());
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setDraft(emptyDraft());
      setNameError(null);
    }
  }, [open]);

  async function handleSubmit() {
    if (!draft.name.trim()) {
      setNameError("Name is required");
      return;
    }
    setSaving(true);
    try {
      const priceNum = draft.price.trim() ? Number(draft.price) : null;
      await productsApi.create({
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        status: draft.status,
        price: priceNum,
        currency: draft.currency,
      });
      toast.success("Product created");
      onCreated();
    } catch (e) {
      toast.error((e as Error)?.message ?? "Failed to create product");
    }
    setSaving(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create product</DialogTitle>
        </DialogHeader>
        <ProductForm
          draft={draft}
          setDraft={setDraft}
          nameError={nameError}
          setNameError={setNameError}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditProductModal({
  product,
  onOpenChange,
  onSaved,
}: {
  product: ProductListItem | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<ProductDraft>(emptyDraft());
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  useEffect(() => {
    if (product) {
      setDraft({
        name: product.name,
        description: product.description ?? "",
        status: product.status,
        price: product.price == null ? "" : String(product.price),
        currency: product.currency,
      });
      setNameError(null);
    }
  }, [product]);

  async function handleSubmit() {
    if (!product) return;
    if (!draft.name.trim()) {
      setNameError("Name is required");
      return;
    }
    setSaving(true);
    try {
      const priceNum = draft.price.trim() ? Number(draft.price) : null;
      await productsApi.update({
        id: product.id,
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        status: draft.status,
        price: priceNum,
        currency: draft.currency,
      });
      toast.success("Product updated");
      onSaved();
    } catch (e) {
      toast.error((e as Error)?.message ?? "Failed to update product");
    }
    setSaving(false);
  }

  return (
    <Dialog open={product !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit product</DialogTitle>
        </DialogHeader>
        <ProductForm
          draft={draft}
          setDraft={setDraft}
          nameError={nameError}
          setNameError={setNameError}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProductForm({
  draft,
  setDraft,
  nameError,
  setNameError,
}: {
  draft: ProductDraft;
  setDraft: (d: ProductDraft) => void;
  nameError: string | null;
  setNameError: (e: string | null) => void;
}) {
  return (
    <div className="space-y-4 py-2">
      <div className="space-y-2">
        <Label htmlFor="product-name">Name</Label>
        <Input
          id="product-name"
          value={draft.name}
          onChange={(e) => {
            setDraft({ ...draft, name: e.target.value });
            setNameError(null);
          }}
          placeholder="e.g. Growth Suite Pro"
        />
        {nameError && <p className="text-sm text-destructive">{nameError}</p>}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="product-price">Price</Label>
          <Input
            id="product-price"
            type="number"
            step="0.01"
            value={draft.price}
            onChange={(e) => setDraft({ ...draft, price: e.target.value })}
            placeholder="299.00"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="product-currency">Currency</Label>
          <Input
            id="product-currency"
            value={draft.currency}
            onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase().slice(0, 3) })}
            placeholder="USD"
            maxLength={3}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="product-status">Status</Label>
        <select
          id="product-status"
          value={draft.status}
          onChange={(e) => setDraft({ ...draft, status: e.target.value as ProductStatus })}
          className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
        >
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="product-description">Description</Label>
        <textarea
          id="product-description"
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          rows={3}
          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm"
          placeholder="Describe the product for the AI..."
        />
      </div>
    </div>
  );
}

/* ── Variant Modal ───────────────────────────────────────────────────── */

function CreateVariantModal({
  productId,
  parentPrice,
  open,
  onOpenChange,
  onCreated,
}: {
  productId: string;
  parentPrice: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [attributesJson, setAttributesJson] = useState('{"size":"M"}');
  const [price, setPrice] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setAttributesJson('{"size":"M"}');
      setPrice("");
      setError(null);
    }
  }, [open]);

  async function handleSubmit() {
    setError(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(attributesJson);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Attributes must be a JSON object");
      }
    } catch (e) {
      setError((e as Error)?.message ?? "Invalid JSON");
      return;
    }
    setSaving(true);
    try {
      const priceNum = price.trim() ? Number(price) : null;
      await productVariantsApi.create({
        productId,
        attributes: parsed,
        price: priceNum,
      });
      toast.success("Variant created");
      onCreated();
    } catch (e) {
      setError((e as Error)?.message ?? "Failed to create variant");
    }
    setSaving(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add variant</DialogTitle>
          <DialogDescription>
            Variants model product dimensions like size, color, or material. Leave price empty to inherit from parent (
            {parentPrice == null ? "no parent price set" : `currently ${parentPrice}`}).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="variant-attributes">Attributes (JSON)</Label>
            <textarea
              id="variant-attributes"
              value={attributesJson}
              onChange={(e) => setAttributesJson(e.target.value)}
              rows={3}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono shadow-sm"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="variant-price">Price (optional)</Label>
            <Input
              id="variant-price"
              type="number"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="Leave empty to inherit from parent"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Categories Tab (Step 7) ─────────────────────────────────────────── */

function CategoriesTab() {
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ProductCategoryListItem | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery<CursorPage<ProductCategoryListItem>>({
    queryKey: ["productCategories", "list"],
    queryFn: () => productCategoriesApi.list({ limit: 200 }),
  });

  const items = data?.items ?? [];

  // Build parent lookup for name resolution.
  const byId = useMemo(() => {
    const m = new Map<string, ProductCategoryListItem>();
    for (const c of items) m.set(c.id, c);
    return m;
  }, [items]);

  // Compute depth for visual indent (parent-chain walk, capped at MAX_CATEGORY_DEPTH=5).
  function depthOf(c: ProductCategoryListItem): number {
    let depth = 0;
    let cur: ProductCategoryListItem | undefined = c;
    while (cur?.parentId && depth < 5) {
      cur = byId.get(cur.parentId);
      depth++;
    }
    return depth;
  }

  async function handleArchive(c: ProductCategoryListItem) {
    if (!confirm(`Archive "${c.name}"?`)) return;
    try {
      await productCategoriesApi.archive(c.id);
      toast.success("Category archived");
      void refetch();
    } catch (e) {
      toast.error((e as Error)?.message ?? "Failed to archive category");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Group products into a hierarchy. Max depth 5 levels.
        </p>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Create category
        </Button>
      </div>

      {isError && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="py-4 text-sm text-destructive/80">{(error as Error)?.message}</CardContent>
        </Card>
      )}

      {isLoading && <p className="text-sm text-muted-foreground">Loading categories...</p>}

      {!isLoading && items.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <p className="text-sm font-medium">No categories yet</p>
            <p className="text-xs text-muted-foreground">Click Create to add your first category</p>
          </CardContent>
        </Card>
      )}

      <div className="space-y-1">
        {items.map((c) => {
          const depth = depthOf(c);
          const parentName = c.parentId ? byId.get(c.parentId)?.name ?? "—" : null;
          return (
            <div key={c.id} className="flex items-center justify-between rounded-md border bg-card px-3 py-2">
              <div style={{ paddingLeft: `${depth * 16}px` }} className="flex items-center gap-2 flex-1">
                <span className="text-sm font-medium">{c.name}</span>
                <Badge variant={statusBadgeVariant(c.status)} className="text-xs">
                  {STATUS_LABEL[c.status]}
                </Badge>
                {parentName && (
                  <span className="text-xs text-muted-foreground">
                    parent: {parentName}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}>
                  <Pencil className="h-4 w-4" />
                </Button>
                {c.status !== "archived" && (
                  <Button variant="ghost" size="icon" onClick={() => handleArchive(c)} aria-label={`Archive ${c.name}`}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <CreateCategoryModal
        existing={items}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setCreateOpen(false);
          void refetch();
        }}
      />

      <EditCategoryModal
        existing={items}
        category={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSaved={() => {
          setEditing(null);
          void refetch();
        }}
      />
    </div>
  );
}

interface CategoryDraft {
  name: string;
  description: string;
  parentId: string | null;
  status: ProductStatus;
}

function emptyCategoryDraft(): CategoryDraft {
  return { name: "", description: "", parentId: null, status: "draft" };
}

function CreateCategoryModal({
  existing,
  open,
  onOpenChange,
  onCreated,
}: {
  existing: ProductCategoryListItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [draft, setDraft] = useState<CategoryDraft>(emptyCategoryDraft());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setDraft(emptyCategoryDraft());
      setError(null);
    }
  }, [open]);

  async function handleSubmit() {
    if (!draft.name.trim()) {
      setError("Name is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await productCategoriesApi.create({
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        parentId: draft.parentId,
        status: draft.status,
      });
      toast.success("Category created");
      onCreated();
    } catch (e) {
      setError((e as Error)?.message ?? "Failed to create category");
    }
    setSaving(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create category</DialogTitle>
        </DialogHeader>
        <CategoryForm existing={existing} draft={draft} setDraft={setDraft} error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditCategoryModal({
  existing,
  category,
  onOpenChange,
  onSaved,
}: {
  existing: ProductCategoryListItem[];
  category: ProductCategoryListItem | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<CategoryDraft>(emptyCategoryDraft());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (category) {
      setDraft({
        name: category.name,
        description: category.description ?? "",
        parentId: category.parentId,
        status: category.status,
      });
      setError(null);
    }
  }, [category]);

  async function handleSubmit() {
    if (!category) return;
    if (!draft.name.trim()) {
      setError("Name is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await productCategoriesApi.update({
        id: category.id,
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        parentId: draft.parentId,
        status: draft.status,
      });
      toast.success("Category updated");
      onSaved();
    } catch (e) {
      setError((e as Error)?.message ?? "Failed to update category");
    }
    setSaving(false);
  }

  // When editing, the parent dropdown must exclude self + descendants to
  // avoid cycles. Service-layer CategoryCycleDetectedError catches at the
  // backend; this is a UI-side hint.
  const parentOptions = existing.filter((c) => c.id !== category?.id);

  return (
    <Dialog open={category !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit category</DialogTitle>
        </DialogHeader>
        <CategoryForm existing={parentOptions} draft={draft} setDraft={setDraft} error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CategoryForm({
  existing,
  draft,
  setDraft,
  error,
}: {
  existing: ProductCategoryListItem[];
  draft: CategoryDraft;
  setDraft: (d: CategoryDraft) => void;
  error: string | null;
}) {
  return (
    <div className="space-y-4 py-2">
      <div className="space-y-2">
        <Label htmlFor="category-name">Name</Label>
        <Input
          id="category-name"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="e.g. Apparel"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="category-parent">Parent (optional)</Label>
        <select
          id="category-parent"
          value={draft.parentId ?? ""}
          onChange={(e) => setDraft({ ...draft, parentId: e.target.value || null })}
          className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
        >
          <option value="">— Root —</option>
          {existing.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="category-status">Status</Label>
        <select
          id="category-status"
          value={draft.status}
          onChange={(e) => setDraft({ ...draft, status: e.target.value as ProductStatus })}
          className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
        >
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="category-description">Description</Label>
        <textarea
          id="category-description"
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          rows={2}
          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm"
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
