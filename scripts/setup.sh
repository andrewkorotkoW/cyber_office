#!/usr/bin/env bash
# Первая настройка cyber_office на macOS/Linux: venv, зависимости, .env, workspace/,
# sandbox/, проверка claude — и запуск сервера. Повторный запуск ничего не ломает.
# Использование: ./scripts/setup.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "== cyber_office: настройка =="

# 1) Python 3.11+
PYTHON_BIN=""
for cand in python3.11 python3 python; do
  if command -v "$cand" >/dev/null 2>&1; then
    ver="$("$cand" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo 0.0)"
    major="${ver%%.*}"; minor="${ver#*.}"
    if [ "$major" -gt 3 ] 2>/dev/null || { [ "$major" -eq 3 ] 2>/dev/null && [ "$minor" -ge 11 ] 2>/dev/null; }; then
      PYTHON_BIN="$cand"; break
    fi
  fi
done
if [ -z "$PYTHON_BIN" ]; then
  echo "Нужен Python 3.11 или новее — не нашёл его в PATH (пробовал python3.11/python3/python)." >&2
  echo "Установи: https://www.python.org/downloads/" >&2
  exit 1
fi
echo "Python: $("$PYTHON_BIN" --version)"

# 2) git
if ! command -v git >/dev/null 2>&1; then
  echo "Нужен git — не нашёл его в PATH. Установи: https://git-scm.com/downloads" >&2
  exit 1
fi
echo "git: $(git --version)"

# 3) venv + зависимости (идемпотентно: venv создаётся один раз, pip install безопасно перезапускать)
if [ ! -d .venv ]; then
  echo "Создаю .venv…"
  "$PYTHON_BIN" -m venv .venv
fi
VENV_PY=.venv/bin/python
echo "Ставлю зависимости из requirements.txt…"
"$VENV_PY" -m pip install --upgrade pip -q
"$VENV_PY" -m pip install -r requirements.txt -q

# 4) .env из примера (не трогаем существующий)
if [ ! -f .env ]; then
  cp .env.example .env
  echo ".env создан из .env.example — при желании отредактируй (токен бота, порт, …)."
fi

# 5) claude CLI — не обязателен (есть AO_FAKE=1), но без него нет реальных агентов
if command -v claude >/dev/null 2>&1 && claude --version >/dev/null 2>&1; then
  echo "claude: $(claude --version)"
else
  cat >&2 <<'EOF'

claude (Claude Code CLI) не найден или не отвечает на `claude --version`.
Без него офис не сможет запускать настоящих агентов, но можно посмотреть
интерфейс в режиме имитации: AO_FAKE=1 .venv/bin/python -m app.main
Установка Claude Code: https://docs.claude.com/en/docs/claude-code
После установки выполни `claude`, затем `/login`.
EOF
fi

# 6) workspace/ и repos.json из примера
mkdir -p workspace
if [ ! -f workspace/repos.json ]; then
  cp workspace/repos.example.json workspace/repos.json
  echo "workspace/repos.json создан из примера — отредактируй его или добавь репозитории кнопкой «＋» в интерфейсе."
fi

# 7) sandbox/ — маленький git-репозиторий-пример для первой задачи
if [ ! -d sandbox/.git ]; then
  rm -rf sandbox
  cp -r sandbox_template sandbox
  git -C sandbox init -q
  git -C sandbox -c user.email="sandbox@cyber-office.local" -c user.name="cyber_office" add -A
  git -C sandbox -c user.email="sandbox@cyber-office.local" -c user.name="cyber_office" commit -q -m "sandbox: начальное состояние"
  echo "sandbox/ инициализирован как отдельный git-репозиторий."
fi

echo
echo "Готово. Открой http://${AO_HOST:-127.0.0.1}:${AO_PORT:-8600} в браузере."
echo "Запускаю сервер (Ctrl+C — остановить)…"
exec "$VENV_PY" -m app.main
