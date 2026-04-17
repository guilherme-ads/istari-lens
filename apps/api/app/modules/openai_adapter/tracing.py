from __future__ import annotations

from dataclasses import dataclass, field

from app.modules.openai_adapter.schemas import OpenAITraceMetadata


@dataclass
class OpenAITraceCollector:
    _events: list[OpenAITraceMetadata] = field(default_factory=list)

    def add(self, event: OpenAITraceMetadata) -> None:
        self._events.append(event)

    def consume(self) -> list[OpenAITraceMetadata]:
        items = list(self._events)
        self._events.clear()
        return items
