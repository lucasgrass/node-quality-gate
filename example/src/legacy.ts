// Deliberately awkward code: the gate records its violations in the baseline
// and only complains when they get worse.

type Order = { items: Array<{ price: number; quantity: number; taxable: boolean }>; coupon?: string; vip: boolean };

export function orderTotal(order: Order): number {
  let total = 0;
  for (const item of order.items) {
    if (item.quantity > 0) {
      if (item.price > 0) {
        if (item.taxable) {
          if (order.vip) {
            if (order.coupon === 'VIP10') {
              total += item.price * item.quantity * 1.1 * 0.9;
            } else {
              total += item.price * item.quantity * 1.1;
            }
          } else {
            total += item.price * item.quantity * 1.1;
          }
        } else {
          total += item.price * item.quantity;
        }
      }
    }
  }
  return Math.round(total * 100) / 100;
}

export function describe(order: Order, locale: string, verbose: boolean, currency: string): string {
  const total = orderTotal(order);
  const money = new Intl.NumberFormat(locale, { style: 'currency', currency }).format(total);
  return verbose ? `${order.items.length} items, total ${money}` : money;
}
