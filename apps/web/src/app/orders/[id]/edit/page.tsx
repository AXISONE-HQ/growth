'use client';

/**
 * KAN-945 — Sub-cohort 3.4 Edit Order route.
 */
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import {
  OrderForm,
  orderToFormValues,
} from '@/components/orders/order-form';
import { ordersApi, type OrderDetail } from '@/lib/api';

function formatContactLabel(c: OrderDetail['contact']): string {
  const name = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim();
  return name ? `${name}${c.email ? ` <${c.email}>` : ''}` : c.email ?? c.id;
}

export default function EditOrderPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const { data: order, isLoading, isError, error } = useQuery<OrderDetail>({
    queryKey: ['orders', 'get', id],
    queryFn: () => ordersApi.get(id as string),
    enabled: !!id,
  });

  if (!id) return null;
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <p className="text-sm" style={{ color: 'var(--ds-danger-text)' }}>
          {error instanceof Error ? error.message : 'Failed to load order'}
        </p>
      </div>
    );
  }
  if (!order) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <p className="text-sm">Order not found.</p>
      </div>
    );
  }

  return (
    <OrderForm
      mode="edit"
      orderId={id}
      initialValues={orderToFormValues(order)}
      initialContactLabel={formatContactLabel(order.contact)}
      initialCompanyLabel={order.company?.name}
      initialDealLabel={order.deal?.name}
    />
  );
}
