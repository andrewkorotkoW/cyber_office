"""Telegram-мост: задачи из чата -> офис, результаты из офиса -> чат.

Работает внутри процесса сервера (тот же Office, та же шина событий), поэтому
никаких HTTP-вызовов к себе. Слушает только tg_id из AO_TG_ADMINS: этот бот
запускает агентов на твоих репозиториях, чужим он должен молчать.

Как пользоваться:
  любой текст                — задача Майклу в текущий репозиторий
  @dwight текст / @pam текст — задача другому агенту
  /repo                      — выбрать текущий репозиторий (кнопки)
  /newproject имя [описание] — создать новый проект и сделать его текущим
  /mission текст             — миссия: Майкл спланирует и раздаст
  /status                    — доска
  /digest                    — сводка Оскара («что происходит»)
  /diff <id>                 — diff задачи файлом
Когда задача готова, приходит карточка с кнопками «Одобрить / Отклонить / Повторить».
"""
from __future__ import annotations

import asyncio
import html
import logging
import re

from aiogram import Bot, Dispatcher, F, Router
from aiogram.filters import Command, CommandStart
from aiogram.types import BufferedInputFile, CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message

from app import config
from app.core import repo_init
from app.core.events import Event, bus
from app.core.office import Office

log = logging.getLogger("cyber_office.telegram")
router = Router(name="tg")

import json

_office: Office | None = None
_bot: Bot | None = None
_repos_fn = None
_after_merge_cmd_fn = None
_register_repo_fn = None
_PREFS = config.WORKSPACE / "tg_prefs.json"
_current_repo: dict[int, str] = {}          # tg_id -> выбранный репозиторий (хранится в tg_prefs.json)
_pending_reason: dict[int, str] = {}       # tg_id -> task_id, ждём текст причины отклонения
_pending_task: dict[int, tuple[str, str]] = {}   # tg_id -> (agent, text): задача ждёт выбора репозитория
_pending_newrepo: set[int] = set()         # tg_id -> следующим текстом ждём "имя [описание]" нового проекта
_portrait_sent: set[str] = set()           # id задач, для которых уже отправляли фото-портрет агента
PORTRAITS_DIR = config.ROOT / "ui" / "assets" / "portraits"


def _load_prefs() -> None:
    global _current_repo
    try:
        _current_repo = {int(k): v for k, v in json.loads(_PREFS.read_text(encoding="utf-8")).items()}
    except Exception:
        _current_repo = {}


def _save_prefs() -> None:
    _PREFS.write_text(json.dumps(_current_repo, ensure_ascii=False, indent=2), encoding="utf-8")

STATUS_RU = {"todo": "в очереди", "running": "в работе", "review": "на ревью", "done": "готово",
             "failed": "ошибка", "rejected": "отклонено"}
ESC = lambda s: html.escape(str(s or ""))


def _is_admin(uid: int) -> bool:
    return uid in config.TG_ADMINS


def _repo_name(path: str) -> str:
    return path.rstrip("/").split("/")[-1]


def _repo_for(uid: int) -> str | None:
    """Выбранный репозиторий или None — тогда бот спросит. Молча слать в первый попавшийся
    нельзя: задача про Velo_bot однажды уехала в песочницу с калькулятором."""
    r = _current_repo.get(uid)
    return r if r and r in _repos_fn() else None


def _repo_kb() -> InlineKeyboardMarkup:
    repos = _repos_fn()
    rows = [[InlineKeyboardButton(text="➕ Новый проект", callback_data="ao:newrepo")]]
    rows += [[InlineKeyboardButton(text=_repo_name(r), callback_data=f"ao:repo:{i}")] for i, r in enumerate(repos)]
    return InlineKeyboardMarkup(inline_keyboard=rows)


def _repo_switch_kb() -> InlineKeyboardMarkup:
    """Кнопка под карточкой созданной задачи/миссии — показывает, куда она ушла,
    и даёт быстро сменить репозиторий по умолчанию для следующих задач."""
    return InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text="🔁 сменить репозиторий", callback_data="ao:reposwitch")]])


def _agent_title(name: str) -> str:
    a = _office.roster.get(name)
    return a.title.split("·")[0].strip() if a else name


def _task_card(t) -> str:
    lines = [f"<b>{ESC(t.title)}</b> · {_agent_title(t.agent)} · {_repo_name(t.repo)}",
             f"Статус: <b>{STATUS_RU.get(t.status, t.status)}</b>"
             + (f" · ≈${t.cost_usd:.2f} по API" if t.cost_usd else "")]
    if t.result:
        res = " ".join(t.result.split())
        lines.append("")
        lines.append(ESC(res[:1500] + ("…" if len(res) > 1500 else "")))
    if t.diff_stat:
        lines.append("")
        lines.append("<code>" + ESC(t.diff_stat.strip()[-600:]) + "</code>")
    if t.status == "review" and t.overlap_files:
        lines.append(f"\n⚠️ Ветка отстала от main на {t.behind_main}; пересекается по файлам: "
                     f"{ESC(', '.join(t.overlap_files[:4]))}. При конфликте офис сам перенесёт работу поверх main.")
    if t.status == "failed" and t.log:
        lines.append("")
        lines.append("⚠️ " + ESC(t.log[-1]))
    lines.append(f"\n<code>{t.id}</code>")
    return "\n".join(lines)


def _task_kb(t) -> InlineKeyboardMarkup | None:
    rows = []
    if t.status == "review":
        rows.append([InlineKeyboardButton(text="✅ Одобрить", callback_data=f"ao:approve:{t.id}"),
                     InlineKeyboardButton(text="❌ Отклонить", callback_data=f"ao:reject:{t.id}"),
                     InlineKeyboardButton(text="📄 Diff", callback_data=f"ao:diff:{t.id}")])
    elif t.status in ("failed", "rejected"):
        rows.append([InlineKeyboardButton(text="🔁 Повторить", callback_data=f"ao:retry:{t.id}"),
                     InlineKeyboardButton(text="🗑 Удалить", callback_data=f"ao:delete:{t.id}")])
    elif t.status == "running":
        rows.append([InlineKeyboardButton(text="⏹ Остановить", callback_data=f"ao:stop:{t.id}")])
    return InlineKeyboardMarkup(inline_keyboard=rows) if rows else None


# ------------------------------------------------------------------ команды
@router.message(CommandStart())
async def start(message: Message) -> None:
    uid = message.from_user.id
    if not _is_admin(uid):
        await message.answer(f"Этот офис не твой. Твой id: <code>{uid}</code>", parse_mode="HTML")
        return
    await message.answer(
        "<b>cyber_office</b> на связи.\n\n"
        "• любой текст — задача Майклу в текущий репозиторий\n"
        "• <code>@dwight текст</code> / <code>@pam текст</code> — другому агенту\n"
        "• /repo — выбрать репозиторий\n"
        "• /newproject имя [описание] — создать новый проект\n"
        "• /mission текст — миссия: Майкл спланирует и раздаст команде\n"
        "• /status — доска\n"
        "• /digest — сводка Оскара («что происходит»)\n\n"
        f"Текущий репозиторий: <b>{ESC(_repo_name(_repo_for(uid) or '')) or 'не выбран — /repo'}</b>",
        parse_mode="HTML")


@router.message(Command("repo"))
async def repo(message: Message) -> None:
    if not _is_admin(message.from_user.id):
        return
    await message.answer("Репозиторий для новых задач:", reply_markup=_repo_kb())


@router.callback_query(F.data.startswith("ao:repo:"))
async def repo_pick(callback: CallbackQuery) -> None:
    if not _is_admin(callback.from_user.id):
        await callback.answer(); return
    repos = _repos_fn()
    i = int(callback.data.rsplit(":", 1)[-1])
    if 0 <= i < len(repos):
        uid = callback.from_user.id
        _current_repo[uid] = repos[i]; _save_prefs()
        await callback.message.edit_text(f"Репозиторий: <b>{ESC(_repo_name(repos[i]))}</b>", parse_mode="HTML")
        pending = _pending_task.pop(uid, None)
        if pending:                                   # задача ждала выбора — создаём
            await _create(callback.message, uid, *pending)
    await callback.answer()


@router.callback_query(F.data == "ao:newrepo")
async def newrepo_button(callback: CallbackQuery) -> None:
    if not _is_admin(callback.from_user.id):
        await callback.answer(); return
    _pending_newrepo.add(callback.from_user.id)
    await callback.message.answer(
        "Имя нового проекта (латиница/цифры/_-), можно одной строкой с описанием:\n"
        "<code>my_bot Бот для заказов в Telegram</code>", parse_mode="HTML")
    await callback.answer()


@router.callback_query(F.data == "ao:reposwitch")
async def reposwitch_button(callback: CallbackQuery) -> None:
    if not _is_admin(callback.from_user.id):
        await callback.answer(); return
    await callback.message.answer("Репозиторий по умолчанию для следующих задач:", reply_markup=_repo_kb())
    await callback.answer()


@router.message(Command("newproject"))
async def newproject(message: Message) -> None:
    uid = message.from_user.id
    if not _is_admin(uid):
        return
    parts = (message.text or "").split(maxsplit=2)
    if len(parts) < 2:
        await message.answer("Использование: /newproject имя_проекта [описание]\nШаблон — python, .venv ставится в фоне.")
        return
    name = parts[1]
    description = parts[2] if len(parts) > 2 else ""
    await _create_repo(message, uid, name, description)


async def _create_repo(target: Message, uid: int, name: str, description: str) -> None:
    try:
        path = await repo_init.create(config.PROJECTS_DIR, name, description, "python")
    except ValueError as exc:
        await target.answer(f"Не вышло: {ESC(exc)}", parse_mode="HTML"); return
    _register_repo_fn(path)
    _current_repo[uid] = path; _save_prefs()
    asyncio.create_task(repo_init.setup_venv(path))
    await target.answer(f"📁 Создан проект <b>{ESC(_repo_name(path))}</b> — теперь это твой текущий репозиторий.\n"
                        f"Окружение (.venv) ставится в фоне.", parse_mode="HTML")
    pending = _pending_task.pop(uid, None)
    if pending:                                   # задача ждала выбора репозитория — создаём в новом
        await _create(target, uid, *pending)


@router.message(Command("status"))
async def status(message: Message) -> None:
    if not _is_admin(message.from_user.id):
        return
    tasks = sorted(_office.store.tasks.values(), key=lambda t: t.updated_at, reverse=True)
    repo = _repo_for(message.from_user.id)
    show_all = "all" in (message.text or "").lower() or not repo
    if not show_all:
        tasks = [t for t in tasks if t.repo == repo]
    agents = ", ".join(f"{_agent_title(a.name)}: {a.state}" for a in _office.roster.agents.values())
    scope = "все репозитории" if show_all else f"репозиторий <b>{ESC(_repo_name(repo))}</b> (/status all — все)"
    lines = [f"👥 {agents}", f"📁 {scope}", ""]
    for status_key in ("running", "review", "todo", "failed"):
        items = [t for t in tasks if t.status == status_key][:8]
        if items:
            lines.append(f"<b>{STATUS_RU[status_key]}</b>")
            lines += [f"• {ESC(t.title)} — {_agent_title(t.agent)} <code>{t.id}</code>" for t in items]
    done = sum(1 for t in tasks if t.status == "done")
    lines.append(f"\nготово всего: {done}")
    await message.answer("\n".join(lines), parse_mode="HTML")


@router.message(Command("digest"))
async def digest_cmd(message: Message) -> None:
    if not _is_admin(message.from_user.id):
        return
    from app.core import digest
    cache = digest.load_cache()
    if cache is None:
        await message.answer("Оскар молчит: сводка ещё не собиралась."); return
    text = cache.get("text")
    if text:
        await message.answer(f"🧮 <b>Оскар:</b>\n{ESC(text)}", parse_mode="HTML")
        return
    reason = cache.get("error") or "не запускался"
    await message.answer(f"Оскар молчит: {ESC(reason)}\n\n{_facts_summary(cache.get('facts') or {})}",
                         parse_mode="HTML")


def _facts_summary(facts: dict) -> str:
    lines = []
    for bucket in (facts.get("repos") or {}).values():
        parts = []
        if bucket.get("missions"):
            parts.append(f"миссии: {len(bucket['missions'])}")
        if bucket.get("running"):
            parts.append(f"в работе: {len(bucket['running'])}")
        if bucket.get("review"):
            parts.append(f"на ревью: {len(bucket['review'])}")
        if bucket.get("todo"):
            parts.append(f"в очереди: {len(bucket['todo'])}")
        if bucket.get("failed_24h"):
            parts.append(f"упало за сутки: {len(bucket['failed_24h'])}")
        if bucket.get("paused"):
            parts.append("на паузе")
        lines.append(f"📁 <b>{ESC(bucket.get('name', '?'))}</b>: " + (", ".join(parts) if parts else "тихо"))
    since = facts.get("since_last") or {}
    if since:
        lines.append(f"\nс прошлой сводки: сделано {since.get('done_tasks', 0)}, "
                     f"упало {since.get('failed_tasks', 0)}, ≈${since.get('cost_usd', 0):.2f} по API")
    return "\n".join(lines) if lines else "фактов пока нет"


@router.message(Command("mission"))
async def mission(message: Message) -> None:
    uid = message.from_user.id
    if not _is_admin(uid):
        return
    goal = (message.text or "").split(maxsplit=1)[1:] or [""]
    goal = goal[0].strip()
    if not goal:
        await message.answer("Напиши цель: /mission добавить в calc степень и процент, покрыть тестами")
        return
    repo = _repo_for(uid)
    if not repo:
        await message.answer("Сначала выбери репозиторий:", reply_markup=_repo_kb()); return
    try:
        m = await _office.create_mission(goal, repo)
    except ValueError as exc:
        await message.answer(f"Не вышло: {ESC(exc)}", parse_mode="HTML"); return
    await message.answer(f"🎯 Миссия принята → <b>{ESC(_repo_name(repo))}</b>, Майкл планирует.\n<code>{m.id}</code>",
                         parse_mode="HTML", reply_markup=_repo_switch_kb())


@router.message(Command("diff"))
async def diff_cmd(message: Message) -> None:
    if not _is_admin(message.from_user.id):
        return
    parts = (message.text or "").split()
    if len(parts) < 2:
        await message.answer("/diff <id задачи>"); return
    await _send_diff(message, parts[1])


async def _send_diff(target: Message, task_id: str) -> None:
    d = await _office.diff(task_id)
    if not d:
        await target.answer("Diff пуст."); return
    await target.answer_document(BufferedInputFile(d.encode("utf-8"), filename=f"{task_id}.diff"))


# ------------------------------------------------------------------ задача текстом
@router.message(F.text & ~F.text.startswith("/"))
async def new_task(message: Message) -> None:
    uid = message.from_user.id
    if not _is_admin(uid):
        return
    text = message.text.strip()
    if uid in _pending_reason:                       # это причина отклонения
        task_id = _pending_reason.pop(uid)
        ok = await _office.reject(task_id, text)
        await message.answer("Отклонено, причина сохранена." if ok else "Задачу уже нельзя отклонить.")
        return
    if uid in _pending_newrepo:                       # это "имя [описание]" нового проекта
        _pending_newrepo.discard(uid)
        parts = text.split(maxsplit=1)
        name, description = parts[0], (parts[1] if len(parts) > 1 else "")
        await _create_repo(message, uid, name, description)
        return
    agent = "michael"
    m = re.match(r"@(\w+)\s+(.+)", text, re.S)
    if m and _office.roster.get(m.group(1).lower()):
        agent, text = m.group(1).lower(), m.group(2).strip()
    repo = _repo_for(uid)
    if not repo:
        _pending_task[uid] = (agent, text)
        await message.answer("В какой репозиторий? Задачу запомнил, выбери:", reply_markup=_repo_kb()); return
    await _create(message, uid, agent, text)


async def _create(target: Message, uid: int, agent: str, text: str) -> None:
    title = text.split("\n", 1)[0][:80]
    try:
        t = await _office.create_task(title, text, _repo_for(uid), agent)
    except ValueError as exc:
        await target.answer(f"Не вышло: {ESC(exc)}", parse_mode="HTML"); return
    await target.answer(f"✉️ Принято → {_agent_title(agent)} · <b>{ESC(_repo_name(t.repo))}</b>\n<code>{t.id}</code>",
                        parse_mode="HTML", reply_markup=_repo_switch_kb())


# ------------------------------------------------------------------ кнопки ревью
@router.callback_query(F.data.startswith("ao:"))
async def actions(callback: CallbackQuery) -> None:
    uid = callback.from_user.id
    if not _is_admin(uid):
        await callback.answer(); return
    _, action, task_id = callback.data.split(":", 2)
    if action in ("approve", "approve_force"):
        ok, out = await _office.approve(task_id, force=(action == "approve_force"))
        if not ok and out == _office.EMPTY_DIFF_MSG:
            await callback.answer()
            kb = InlineKeyboardMarkup(inline_keyboard=[[
                InlineKeyboardButton(text="⚠️ Всё равно принять", callback_data=f"ao:approve_force:{task_id}"),
                InlineKeyboardButton(text="❌ Отклонить", callback_data=f"ao:reject:{task_id}")]])
            await callback.message.answer(
                "⚠️ В задаче нет изменений — агент ничего не сделал (часто это отказ в запуске команды, "
                "см. резюме). Принимать такую задачу нет смысла: отклони с причиной или прими принудительно.",
                reply_markup=kb)
            return
        await callback.answer("Влито в main" if ok else (out or "Не удалось")[:180], show_alert=not ok)
        if ok:
            t0 = _office.store.get(task_id)
            if t0:
                asyncio.create_task(_office.run_after_merge(t0.repo, task_id, _after_merge_cmd_fn(t0.repo)))
    elif action == "reject":
        _pending_reason[uid] = task_id
        await callback.answer()
        await callback.message.answer("Почему отклоняешь? Напиши причину одним сообщением — она уйдёт агенту при повторе.")
        return
    elif action == "retry":
        ok = await _office.retry(task_id)
        await callback.answer("Отправлено заново" if ok else "Нельзя повторить", show_alert=not ok)
    elif action == "stop":
        ok = await _office.stop(task_id)
        await callback.answer("Остановлено" if ok else "Не удалось", show_alert=not ok)
    elif action == "delete":
        await _office.delete_task(task_id)
        await callback.answer("Удалено")
    elif action == "diff":
        await callback.answer()
        await _send_diff(callback.message, task_id)
        return
    t = _office.store.get(task_id)
    if t:
        try:
            await callback.message.edit_text(_task_card(t), reply_markup=_task_kb(t), parse_mode="HTML")
        except Exception:
            pass


# ------------------------------------------------------------------ события офиса -> чат
async def _notify_admins(text: str, **kw) -> None:
    if _bot is None:
        return
    for uid in config.TG_ADMINS:
        try:
            await _bot.send_message(uid, text, parse_mode="HTML", **kw)
        except Exception:
            log.exception("tg notify failed")


async def _maybe_send_portrait(t) -> None:
    """При первом уведомлении по задаче — фото-портрет агента (по желанию, не мешает обычной карточке)."""
    if t.id in _portrait_sent:
        return
    _portrait_sent.add(t.id)
    agent = _office.roster.get(t.agent)
    if not agent or not agent.avatar:
        return
    path = PORTRAITS_DIR / agent.avatar
    if not path.exists():
        return
    caption = f"{_agent_title(t.agent)} · {ESC(t.title)[:180]}"
    photo = path.read_bytes()
    for uid in config.TG_ADMINS:
        try:
            await _bot.send_photo(uid, BufferedInputFile(photo, filename=agent.avatar), caption=caption, parse_mode="HTML")
        except Exception:
            log.exception("tg portrait send failed")


async def _on_event(ev: Event) -> None:
    if _bot is None or not config.TG_ADMINS:
        return
    if ev.kind == "task.updated" and ev.data.get("task", {}).get("status") in ("review", "failed", "done"):
        t = _office.store.get(ev.task_id)
        if not t or t.status == "done":
            return
        if t.status == "failed" and t.auto_retry_at:
            return    # автоповтор уже запланирован — про него уведомляем отдельно (task.infra_failure)
        await _maybe_send_portrait(t)
        await _notify_admins(_task_card(t), reply_markup=_task_kb(t))
    elif ev.kind == "task.infra_failure":
        t = ev.data.get("task", {})
        title, reason = t.get("title", ""), ev.data.get("reason", "")
        max_retries = ev.data.get("max_retries")
        if ev.data.get("exhausted"):
            text = (f"🛑 <b>{ESC(title)}</b> так и не восстановилась после {max_retries} автоповторов "
                    f"из-за сбоя API. Нужно вмешательство.\n{ESC(reason)}\n<code>{ESC(t.get('id', ''))}</code>")
        else:
            mins = max(1, round(ev.data.get("delay", 0) / 60))
            text = (f"⚠️ <b>{ESC(title)}</b> упала по ошибке API, повторю через {mins} мин "
                    f"(попытка {ev.data.get('attempt')}/{max_retries}).\n{ESC(reason)}\n<code>{ESC(t.get('id', ''))}</code>")
        await _notify_admins(text)
    elif ev.kind == "repo.after_merge":
        status = "🔄 Приложение перезапущено на новом коде" if ev.data.get("ok") else "⚠️ Хук после мерджа упал"
        await _notify_admins(f"{status}: {ESC(_repo_name(ev.data.get('repo', '')))}\n<code>{ESC(ev.data.get('output', ''))}</code>")
    elif ev.kind == "mission.updated":
        m = ev.data.get("mission", {})
        if m.get("status") in ("active", "failed", "done"):
            text = {"active": "🎯 План готов, задачи розданы", "done": "🏁 Миссия выполнена",
                    "failed": "⚠️ Миссия не спланирована"}[m["status"]]
            text += f": {ESC(m.get('goal', '')[:120])}" + (f"\n{ESC(m.get('summary'))}" if m.get("summary") else "") \
                    + (f"\n{ESC(m.get('error'))}" if m.get("error") else "")
            await _notify_admins(text)


async def run(office: Office, repos_fn, after_merge_cmd_fn, register_repo_fn) -> None:
    """Запускается как фоновая задача сервера, если задан AO_TG_TOKEN."""
    global _office, _bot, _repos_fn, _after_merge_cmd_fn, _register_repo_fn
    _office, _repos_fn, _after_merge_cmd_fn, _register_repo_fn = office, repos_fn, after_merge_cmd_fn, register_repo_fn
    _load_prefs()
    _bot = Bot(token=config.TG_TOKEN)
    dp = Dispatcher()
    dp.include_router(router)
    bus.subscribe(_on_event)
    me = await _bot.get_me()
    log.info("Telegram-мост: @%s, админы %s", me.username, sorted(config.TG_ADMINS))
    await dp.start_polling(_bot, handle_signals=False)
