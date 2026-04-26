"""Python analytics pre-processor in the mixed-language fixture."""


def normalise_event(raw: dict) -> dict:
    """Strip null values and lowercase string property keys."""
    return {k.lower(): v for k, v in raw.items() if v is not None}


def batch_events(events: list[dict], size: int = 50) -> list[list[dict]]:
    """Split a flat list of events into batches of at most `size`."""
    return [events[i : i + size] for i in range(0, len(events), size)]
