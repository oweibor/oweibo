"""Flask route handlers for the order resource."""

from flask import Flask, jsonify, request, abort
from models import Order, OrderItem

app = Flask(__name__)

# In-memory store — fixture only, not production pattern
_orders: dict[str, Order] = {}


@app.route("/orders", methods=["GET"])
def list_orders():
    """Return all orders as a JSON array."""
    return jsonify([vars(o) for o in _orders.values()])


@app.route("/orders/<order_id>", methods=["GET"])
def get_order(order_id: str):
    """Fetch a single order by ID.

    Returns 404 when the order does not exist.
    """
    order = _orders.get(order_id)
    if order is None:
        abort(404, description="Order not found")
    return jsonify(vars(order))


@app.route("/orders", methods=["POST"])
def create_order():
    """Create a new order from the request body.

    Expected JSON: { customer_id: str, items: [{ sku, quantity, unit_price_cents }] }
    """
    body = request.get_json(force=True)
    import uuid

    order_id = str(uuid.uuid4())
    items = [
        OrderItem(
            sku=i["sku"],
            quantity=i["quantity"],
            unit_price_cents=i["unit_price_cents"],
        )
        for i in body.get("items", [])
    ]
    order = Order(id=order_id, customer_id=body["customer_id"], items=items)
    order.total_cents = sum(item.subtotal_cents for item in items)
    _orders[order_id] = order
    return jsonify(vars(order)), 201


@app.route("/orders/<order_id>/cancel", methods=["POST"])
def cancel_order(order_id: str):
    """Cancel an existing order."""
    order = _orders.get(order_id)
    if order is None:
        abort(404)
    try:
        order.cancel()
    except ValueError as exc:
        abort(400, description=str(exc))
    return jsonify(vars(order))
