"""Шина событий: всё, что происходит с задачами и агентами, идёт сюда, а отсюда —
в WebSocket для интерфейса и в лог. Интерфейс (пол, канбан, терминал) — только
подписчик, он ничего не решает."""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Awaitable, Callable

Listener = Callable[["Event"], Awaitable[None]]


@dataclass(slots=True)
class Event:
    kind: str                     # task.created / agent.state / agent.tool / agent.text / task.done ...
    agent: str | None = None
    task_id: str | None = None
    data: dict[str, Any] = field(default_factory=dict)
    ts: float = field(default_factory=time.time)

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)


class EventBus:
    def __init__(self, history: int = 3000) -> None:
        self._listeners: list[Listener] = []
        self.history: list[Event] = []
        self._max = history

    def subscribe(self, fn: Listener) -> None:
        self._listeners.append(fn)

    def unsubscribe(self, fn: Listener) -> None:
        self._listeners = [x for x in self._listeners if x is not fn]

    async def emit(self, kind: str, agent: str | None = None, task_id: str | None = None, **data: Any) -> Event:
        ev = Event(kind=kind, agent=agent, task_id=task_id, data=data)
        self.history.append(ev)
        del self.history[:-self._max]
        for fn in list(self._listeners):
            try:
                await fn(ev)
            except Exception:  # слушатель не должен ронять шину
                pass
        return ev


bus = EventBus()
