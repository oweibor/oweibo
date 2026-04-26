"""Domain models for the fixture Python service."""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional


@dataclass
class Order:
    """Represents a customer order in the system.

    Attributes:
        id: Stable UUID identifier.
        customer_id: Foreign key to the customer record.
        items: Line items on this order.
        total_cents: Order total in smallest currency unit.
        created_at: UTC creation timestamp.
    """

    id: str
    customer_id: str
    items: list["OrderItem"] = field(default_factory=list)
    total_cents: int = 0
    created_at: datetime = field(default_factory=datetime.utcnow)
    cancelled_at: Optional[datetime] = None

    def cancel(self) -> None:
        """Mark the order as cancelled."""
        if self.cancelled_at is not None:
            raise ValueError("Order is already cancelled")
        self.cancelled_at = datetime.utcnow()

    @property
    def is_cancelled(self) -> bool:
        """Return True when the order has been cancelled."""
        return self.cancelled_at is not None


@dataclass
class OrderItem:
    """A single line item within an Order."""

    sku: str
    quantity: int
    unit_price_cents: int

    @property
    def subtotal_cents(self) -> int:
        """Compute the line-item subtotal."""
        return self.quantity * self.unit_price_cents
