"use client";

/**
 * KAN-1219 Slice G2 — ProductTargetCard
 *
 * Operator-facing product card inside the TargetEntityPanel confirmation
 * surface. Renders a single Product entity (name + image + price + key
 * meta) with a selectable checkbox that bubbles up via onToggle.
 *
 * # Memo 56 #10 multi-purpose-helper amortization
 *
 * Mirrors the inventory list card pattern at
 * `apps/web/src/app/settings/inventory/page.tsx` and the product card
 * pattern at `apps/web/src/app/settings/products/page.tsx`. Re-uses the
 * shared Card primitives + Badge + lucide-react icons.
 *
 * # SPO Q2 lock (lazy-load)
 *
 * The card takes a `product` prop that the parent (TargetEntityPanel)
 * already fetched via `products.searchForCampaignTarget`. No internal
 * fetch — keeps the card pure-render. The actual entity metadata is
 * lazy-loaded at panel-mount-time (not snapshotted into Campaign at
 * confirm time).
 */
import { ImageOff, Check } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ProductListItem } from "@/lib/api";

export interface ProductTargetCardProps {
  product: ProductListItem;
  selected: boolean;
  onToggle: (productId: string, nextSelected: boolean) => void;
}

export function ProductTargetCard({
  product,
  selected,
  onToggle,
}: ProductTargetCardProps): JSX.Element {
  const handleClick = (): void => {
    onToggle(product.id, !selected);
  };

  return (
    <Card
      role="button"
      aria-pressed={selected}
      aria-label={`${selected ? "Unselect" : "Select"} ${product.name}`}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
      tabIndex={0}
      className={`cursor-pointer transition-colors ${
        selected
          ? "border-primary bg-primary/5 ring-1 ring-primary"
          : "hover:border-muted-foreground/50"
      }`}
    >
      <CardContent className="flex items-center gap-3 p-3">
        {/* Selection indicator */}
        <div
          className={`h-5 w-5 shrink-0 rounded-sm border-2 flex items-center justify-center ${
            selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-muted-foreground/40"
          }`}
          aria-hidden
        >
          {selected && <Check className="h-3.5 w-3.5" />}
        </div>

        {/* Product image / fallback */}
        <div className="h-14 w-14 shrink-0 rounded-md overflow-hidden bg-muted flex items-center justify-center">
          {product.primaryImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={product.primaryImageUrl}
              alt={product.name}
              className="h-full w-full object-cover"
            />
          ) : (
            <ImageOff className="h-5 w-5 text-muted-foreground" />
          )}
        </div>

        {/* Title + price + status */}
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{product.name}</div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            {product.price != null && (
              <span className="tabular-nums font-medium text-foreground">
                ${product.price.toLocaleString()}
              </span>
            )}
            <Badge variant={product.status === "active" ? "green" : "muted"}>
              {product.status}
            </Badge>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
