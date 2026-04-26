"""Unit tests for the Order domain model."""

import pytest
from models import Order, OrderItem


def make_item(sku: str = "SKU-1", qty: int = 2, price: int = 500) -> OrderItem:
    return OrderItem(sku=sku, quantity=qty, unit_price_cents=price)


class TestOrder:
    def test_subtotal(self):
        item = make_item(qty=3, price=200)
        assert item.subtotal_cents == 600

    def test_cancel_sets_timestamp(self):
        order = Order(id="o-1", customer_id="c-1")
        assert not order.is_cancelled
        order.cancel()
        assert order.is_cancelled
        assert order.cancelled_at is not None

    def test_double_cancel_raises(self):
        order = Order(id="o-2", customer_id="c-1")
        order.cancel()
        with pytest.raises(ValueError, match="already cancelled"):
            order.cancel()
