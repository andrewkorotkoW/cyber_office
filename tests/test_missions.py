import asyncio
import subprocess

import pytest

from app.core.office import Office
from app.core.planner import FakePlanner, parse_plan
from app.core.roster import Roster
from app.core.runner import FakeRunner
from app.core.tasks import TaskStore

pytestmark = pytest.mark.asyncio


async def _wait(cond, timeout=6.0):
    for _ in range(int(timeout / 0.05)):
        if cond():
            return True
        await asyncio.sleep(0.05)
    return False


def test_parse_plan_validates():
    text = 'Вот план:\n{"summary": "s", "tasks": [{"id":"a","title":"A","agent":"michael","prompt":"p"},' \
           '{"id":"b","title":"B","agent":"nobody","prompt":"p","depends_on":["a","zzz"]}]} спасибо'
    plan = parse_plan(text, {"michael", "dwight"})
    assert plan.summary == "s" and [t.key for t in plan.tasks] == ["a", "b"]
    assert plan.tasks[1].agent == "michael" and plan.tasks[1].depends_on == ["a"]   # неизвестные отброшены
    with pytest.raises(ValueError):
        parse_plan("нет json", set())
    with pytest.raises(ValueError):
        parse_plan('{"tasks": [{"id":"a","title":"A","prompt":"p","depends_on":["b"]},'
                   '{"id":"b","title":"B","prompt":"p","depends_on":["a"]}]}', set())   # цикл
    with pytest.raises(ValueError):
        parse_plan('{"tasks": []}', set())


async def test_mission_plans_and_respects_dependencies(workspace):
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    office = Office(store, roster, FakeRunner(delay=0.02), FakePlanner())
    m = await office.create_mission("Сделать калькулятор с тестами и README", workspace["repo"])
    assert await _wait(lambda: store.missions[m.id].status == "active")
    tasks = store.mission_tasks(m.id)
    assert len(tasks) == 3
    t1, t2, t3 = tasks
    assert t2.depends_on == [t1.id] and t3.depends_on == [t1.id]

    assert await _wait(lambda: store.get(t1.id).status == "review")
    await asyncio.sleep(0.2)
    assert store.get(t2.id).status == "todo" and store.get(t3.id).status == "todo"   # ждут t1
    ok, _ = await office.approve(t1.id)
    assert ok
    assert await _wait(lambda: store.get(t2.id).status == "review" and store.get(t3.id).status == "review")
    assert store.missions[m.id].status == "active"
    await office.approve(t2.id); await office.approve(t3.id)
    assert store.missions[m.id].status == "done"
    assert roster.get("michael").state == "idle"


async def test_mission_needs_planner(workspace):
    from app import config
    office = Office(TaskStore(config.TASKS_FILE), Roster(), FakeRunner())
    with pytest.raises(ValueError):
        await office.create_mission("x", workspace["repo"])


def test_store_migrates_old_list_format(workspace, tmp_path):
    from app import config
    config.TASKS_FILE.write_text('[{"id":"a1","title":"t","prompt":"p","repo":"r"}]', encoding="utf-8")
    store = TaskStore(config.TASKS_FILE)
    assert store.get("a1") and store.missions == {}


async def test_merge_conflict_marks_failed_and_retry_rebases(workspace):
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()

    class ConflictRunner(FakeRunner):
        async def run(self, agent, system, model, prompt, cwd, task_id):
            open(f"{cwd}/README.md", "w", encoding="utf-8").write(f"# demo by {task_id}\n")
            return await super().run(agent, system, model, prompt, cwd, task_id)

    office = Office(store, roster, ConflictRunner(delay=0.01))
    a = await office.create_task("A", "a", workspace["repo"], "michael")
    b = await office.create_task("B", "b", workspace["repo"], "dwight")
    assert await _wait(lambda: store.get(a.id).status == "review" and store.get(b.id).status == "review")
    ok, _ = await office.approve(a.id); assert ok
    ok, _ = await office.approve(b.id); assert not ok
    assert store.get(b.id).status == "failed" and "конфликт" in store.get(b.id).log[-1]
    assert await office.retry(b.id)
    assert "-prev" in store.get(b.id).prompt                  # агенту подсказали, где прошлая работа
    branches = subprocess.run(["git", "branch", "--list", f"agent/{b.id}-prev"], cwd=workspace["repo"],
                              capture_output=True, text=True).stdout
    assert f"agent/{b.id}-prev" in branches                   # ветка сохранена
    assert await _wait(lambda: store.get(b.id).status == "review")
    ok, _ = await office.approve(b.id); assert ok            # переделано поверх нового main
