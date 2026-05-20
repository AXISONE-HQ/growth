'use client';

/**
 * KAN-945 — Sub-cohort 3.4 New Order route.
 */
import { OrderForm } from '@/components/orders/order-form';

export default function NewOrderPage() {
  return <OrderForm mode="create" />;
}
