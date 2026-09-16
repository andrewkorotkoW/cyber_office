# Первая настройка cyber_office на Windows: venv, зависимости, .env, workspace/,
# sandbox/, проверка claude — и запуск сервера. Повторный запуск ничего не ломает.
# Использование: powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "== cyber_office: настройка =="

# 1) Python 3.11+ — пробуем `py -3.11`, затем просто `python`/`py`
function Find-Python {
    $tries = @(
        @("py", @("-3.11")),
        @("python", @()),
        @("python3", @()),
        @("py", @())
    )
    foreach ($t in $tries) {
        $cmd = $t[0]; $args = $t[1]
        $found = Get-Command $cmd -ErrorAction SilentlyContinue
        if (-not $found) { continue }
        try {
            $ver = & $cmd @args -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
        } catch { continue }
        if (-not $ver) { continue }
        $parts = $ver.Trim().Split(".")
        if ([int]$parts[0] -gt 3 -or ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 11)) {
            return ,@($cmd, $args)
        }
    }
    return $null
}

$py = Find-Python
if (-not $py) {
    Write-Error "Нужен Python 3.11 или новее — не нашёл его через `py -3.11`/`python`/`python3`. Установи: https://www.python.org/downloads/"
    exit 1
}
$pyCmd = $py[0]; $pyArgs = $py[1]
Write-Host ("Python: " + (& $pyCmd @pyArgs --version))

# 2) git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "Нужен git — не нашёл его в PATH. Установи: https://git-scm.com/downloads"
    exit 1
}
Write-Host ("git: " + (git --version))

# 3) venv + зависимости (идемпотентно)
if (-not (Test-Path ".venv")) {
    Write-Host "Создаю .venv…"
    & $pyCmd @pyArgs -m venv .venv
}
$venvPy = ".\.venv\Scripts\python.exe"
Write-Host "Ставлю зависимости из requirements.txt…"
& $venvPy -m pip install --upgrade pip -q
& $venvPy -m pip install -r requirements.txt -q

# 4) .env из примера (не трогаем существующий)
if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host ".env создан из .env.example — при желании отредактируй (токен бота, порт, …)."
}

# 5) claude CLI — не обязателен (есть AO_FAKE=1), но без него нет реальных агентов
$claude = Get-Command claude -ErrorAction SilentlyContinue
$claudeOk = $false
if ($claude) {
    try { & claude --version | Out-Null; $claudeOk = ($LASTEXITCODE -eq 0) } catch { $claudeOk = $false }
}
if ($claudeOk) {
    Write-Host ("claude: " + (& claude --version))
} else {
    Write-Warning @"
claude (Claude Code CLI) не найден или не отвечает на 'claude --version'.
Без него офис не сможет запускать настоящих агентов, но можно посмотреть
интерфейс в режиме имитации: `$env:AO_FAKE=1; .\.venv\Scripts\python.exe -m app.main`
Установка Claude Code: https://docs.claude.com/en/docs/claude-code
После установки выполни 'claude', затем '/login'.
"@
}

# 6) workspace/ и repos.json из примера
New-Item -ItemType Directory -Force -Path "workspace" | Out-Null
if (-not (Test-Path "workspace\repos.json")) {
    Copy-Item "workspace\repos.example.json" "workspace\repos.json"
    Write-Host "workspace\repos.json создан из примера — отредактируй его или добавь репозитории кнопкой «＋» в интерфейсе."
}

# 7) sandbox/ — маленький git-репозиторий-пример для первой задачи
if (-not (Test-Path "sandbox\.git")) {
    if (Test-Path "sandbox") { Remove-Item -Recurse -Force "sandbox" }
    Copy-Item -Recurse "sandbox_template" "sandbox"
    git -C sandbox init -q
    git -C sandbox -c user.email="sandbox@cyber-office.local" -c user.name="cyber_office" add -A
    git -C sandbox -c user.email="sandbox@cyber-office.local" -c user.name="cyber_office" commit -q -m "sandbox: начальное состояние"
    Write-Host "sandbox/ инициализирован как отдельный git-репозиторий."
}

$hostAddr = if ($env:AO_HOST) { $env:AO_HOST } else { "127.0.0.1" }
$port = if ($env:AO_PORT) { $env:AO_PORT } else { "8600" }
Write-Host ""
Write-Host "Готово. Открой http://${hostAddr}:${port} в браузере."
Write-Host "Запускаю сервер (Ctrl+C — остановить)…"
& $venvPy -m app.main
