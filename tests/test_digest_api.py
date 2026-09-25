"""API сводки «Что происходит?»: GET /api/digest, POST /api/digest/refresh,
POST /api/digest/seen. Паттерн TestClient + reload(app.main) — см.
tests/test_lifespan_and_auto_retry_restart.py; AO_FAKE=1, чтобы DigestScheduler
использовал FakeNarrator и не дёргал реальный claude."""
from __future__ import annotations

import importlib


class SpyNarrator:
    def __init__(self, text: str = "текст сводки") -> None:
        self.calls = 0
        self.text = text

    async def narrate(self, facts: dict) -> str:
        self.calls += 1
        return self.text


def _client(monkeypatch):
    monkeypatch.setenv("AO_FAKE", "1")
    import app.main as main_module
    importlib.reload(main_module)
    return main_module


def test_digest_get_without_cache_returns_facts_and_not_fresh(workspace, monkeypatch):
    main_module = _client(monkeypatch)
    from fastapi.testclient import TestClient

    with TestClient(main_module.app) as client:
        resp = client.get("/api/digest")
        assert resp.status_code == 200
        body = resp.json()
        assert set(body) == {"facts", "text", "generated_at", "fresh"}
        assert body["text"] is None
        assert body["fresh"] is False
        assert "repos" in body["facts"] and "agents" in body["facts"]


def test_digest_refresh_forces_recollection_even_without_changes(workspace, monkeypatch):
    main_module = _client(monkeypatch)
    from fastapi.testclient import TestClient

    with TestClient(main_module.app) as client:
        spy = SpyNarrator()
        main_module.digest_scheduler.narrator = spy

        r1 = client.post("/api/digest/refresh")
        assert r1.status_code == 200
        body1 = r1.json()
        assert set(body1) == {"facts", "text", "generated_at", "fresh"}
        assert body1["text"] == spy.text
        assert body1["fresh"] is True
        assert spy.calls == 1

        r2 = client.post("/api/digest/refresh")   # ничего в store не менялось между вызовами
        assert r2.status_code == 200
        assert spy.calls == 2                     # но narrate позвали снова — refresh форсирует


def test_digest_seen_flips_fresh_to_false_on_next_get(workspace, monkeypatch):
    main_module = _client(monkeypatch)
    from fastapi.testclient import TestClient

    with TestClient(main_module.app) as client:
        client.post("/api/digest/refresh")
        assert client.get("/api/digest").json()["fresh"] is True

        r = client.post("/api/digest/seen")
        assert r.status_code == 200 and r.json() == {"ok": True}

        assert client.get("/api/digest").json()["fresh"] is False
