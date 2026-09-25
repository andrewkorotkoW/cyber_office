"""Состав офиса: кто есть, чем занимается, какой моделью работает.
roster.json в workspace — правится руками или из интерфейса."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field

from app.config import DEFAULT_MODEL, ROSTER_FILE

# имя -> файл портрета в ui/assets/portraits/ (256×256 PNG); используется и как дефолт для записей
# roster.json без поля avatar (старые файлы), и на этаже (ui/floor.js) для выбора именного спрайта тела
AVATAR_BY_NAME = {"michael": "beard.png", "dwight": "cyborg.png", "pam": "pink.png", "ralph": "ralph.png"}

# персонажи, которые не берут задачи из очереди (docs/missions/2026-09-25_status_button_ralph.md) —
# Ральф только считает и докладывает, исполнителем ни при создании задачи, ни при диспетчеризации
# todo, ни в плане миссии он быть не может (см. app.core.office)
NON_WORKER_AGENTS = {"ralph"}

DEFAULT_ROSTER = [
    {"name": "michael", "title": "Майкл · генералист", "model": DEFAULT_MODEL, "desk": 0, "color": "#4f8cff",
     "avatar": "beard.png",
     "system": "Ты опытный разработчик-универсал. Делай задачу целиком: код, тесты, короткое описание изменений. "
               "Не трогай файлы вне задачи. В конце ответь резюме: что сделал, что проверил, что осталось."},
    {"name": "dwight", "title": "Дуайт · тесты и качество", "model": DEFAULT_MODEL, "desk": 1, "color": "#ff9a3c",
     "avatar": "cyborg.png",
     "system": "Ты инженер по качеству. Пишешь тесты, ищешь баги, проверяешь граничные случаи. Код правишь "
               "только если тест выявил дефект. В конце — список найденных проблем и что покрыто тестами."
               "Если руководитель всё же поставил тебе задачу на реализацию кода — сделай её, а не отказывайся: сначала реализация, потом тесты на неё."},
    {"name": "pam", "title": "Пэм · документация", "model": DEFAULT_MODEL, "desk": 2, "color": "#ff4fa3",
     "avatar": "pink.png",
     "system": "Ты технический писатель. README, докстринги, комментарии, changelog. Пишешь коротко и по делу, "
               "на русском, без воды. Код не меняешь."},
    {"name": "ralph", "title": "Ральф · докладчик", "model": DEFAULT_MODEL, "desk": 3, "color": "#39ff88",
     "avatar": "ralph.png",
     "system": "Ты Ральф, корги владельца и докладчик офиса: внимательный, бодрый, докладываешь коротко "
               "и по делу. Считаешь задачи, миссии и проценты выполнения, сравниваешь с прошлой сводкой. "
               "Никаких предположений сверх цифр, которые тебе дали, никакой воды — факты и числа, "
               "можно одну шутку про косточки. Задач на выполнение ты не берёшь: твоя работа — доклад, а не код."},
]


@dataclass(slots=True)
class Agent:
    name: str
    title: str
    system: str
    model: str = DEFAULT_MODEL
    desk: int = 0
    color: str = "#f05a46"
    avatar: str = ""               # имя файла в ui/assets/portraits/, "" — фронтенд рисует спрайт без портрета
    state: str = "idle"           # idle / working / review — рантайм, не сохраняется
    current_task: str | None = field(default=None)

    def public(self) -> dict:
        d = asdict(self); return d


class Roster:
    def __init__(self) -> None:
        self.agents: dict[str, Agent] = {}
        self.load()

    def load(self) -> None:
        if not ROSTER_FILE.exists():
            ROSTER_FILE.parent.mkdir(parents=True, exist_ok=True)
            ROSTER_FILE.write_text(json.dumps(DEFAULT_ROSTER, ensure_ascii=False, indent=2), encoding="utf-8")
        raw_list = json.loads(ROSTER_FILE.read_text(encoding="utf-8"))
        # миграция: roster.json, сохранённый до появления Ральфа, не содержит его — дописываем,
        # чтобы существующие офисы получили персонажа без ручной правки файла
        changed = False
        # миграция 2: до 25.09.2026 докладчик назывался «Оскар» — переименовываем запись в Ральфа
        # (имя, подпись, портрет, характер из DEFAULT_ROSTER), сохраняя выбранную модель
        for r in raw_list:
            if r.get("name") == "oscar":
                default = next(dict(d) for d in DEFAULT_ROSTER if d["name"] == "ralph")
                r.update({k: default[k] for k in ("name", "title", "system", "avatar", "color", "desk")})
                changed = True
        if not any(r.get("name") == "ralph" for r in raw_list):
            raw_list.append(next(dict(d) for d in DEFAULT_ROSTER if d["name"] == "ralph"))
            changed = True
        if changed:
            ROSTER_FILE.write_text(json.dumps(raw_list, ensure_ascii=False, indent=2), encoding="utf-8")
        for raw in raw_list:
            raw = {k: v for k, v in raw.items() if k in ("name", "title", "system", "model", "desk", "color", "avatar")}
            raw.setdefault("avatar", AVATAR_BY_NAME.get(raw.get("name", ""), ""))  # старый roster.json без avatar не ломается
            self.agents[raw["name"]] = Agent(**raw)

    def get(self, name: str) -> Agent | None:
        return self.agents.get(name)

    def public(self) -> list[dict]:
        return [a.public() for a in sorted(self.agents.values(), key=lambda a: a.desk)]
