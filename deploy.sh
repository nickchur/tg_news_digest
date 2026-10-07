#!/usr/bin/env bash
# Выкладка tg-digest: Worker на Cloudflare (только /notify) через REST + исполнитель local.mjs на GCP tgproxy (systemd).
# 2026-10-07 22:41 · v1.12 · Nick Churkin
#
# Настройки и секреты — секрет tg-digest в Bitwarden Secrets Manager (утилита ~/.local/bin/secret):
#   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (права: Workers Scripts Edit, R2 Edit),
#   BOT_TOKEN, TARGET_CHAT, OWNER_ID, ADMIN_KEY, GEMINI_MODEL, DEPLOY_HOST, PROXIES. Бакет R2 tg-digest создаётся, если нет.
# GEMINI_API_KEY — из секрета agy. На GCP секреты лежат в /etc/tg-digest.env (root, 600).
# Заодно ставит меню команд бота. Webhook не ставим: команды берёт long polling local.mjs.
set -euo pipefail
cd "$(dirname "$0")"
S=$(secret tg-digest; echo; secret agy)
set -a; eval "$S"; set +a; unset S

NAME=tg-digest
HOST=$DEPLOY_HOST   # user@host исполнителя (GCP tgproxy)
API="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"
HDR=$(umask 077; mktemp); META=$(umask 077; mktemp); TGCFG=$(umask 077; mktemp)
trap 'rm -f "$HDR" "$META" "$TGCFG"' EXIT
printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN" > "$HDR"
AUTH=(-H @"$HDR")
ok() { python3 -c 'import json,sys; d=json.load(sys.stdin); d["success"] or sys.exit(sys.argv[1] + ": " + str(d["errors"]))' "$1"; }

# хранилище — бакет R2 (бесплатно 1 млн записей в месяц против 1000 в сутки у KV): создать, если нет
curl -s "${AUTH[@]}" "$API/r2/buckets/$NAME" | grep -q '"success":true' ||
  curl -s "${AUTH[@]}" -H 'Content-Type: application/json' -d "{\"name\":\"$NAME\"}" "$API/r2/buckets" | ok bucket

python3 - > "$META" <<'PY'
import json, os
secret = lambda n: {'type': 'secret_text', 'name': n, 'text': os.environ[n]}
plain = lambda n: {'type': 'plain_text', 'name': n, 'text': os.environ[n]}
print(json.dumps({
    'main_module': 'worker.js',
    'compatibility_date': '2026-09-01',
    'compatibility_flags': ['global_fetch_strictly_public'],  # без него fetch наружу ловит 1042
    'bindings': [{'type': 'r2_bucket', 'name': 'DIGEST', 'bucket_name': 'tg-digest'},
                 *[secret(n) for n in ('BOT_TOKEN', 'ADMIN_KEY') if os.environ.get(n)],
                 *[plain(n) for n in ('OWNER_ID',) if os.environ.get(n)]],
}))
PY

curl -s "${AUTH[@]}" -X PUT "$API/workers/scripts/$NAME" \
  -F "metadata=@$META;type=application/json" \
  -F "worker.js=@worker.js;type=application/javascript+module" | ok script
curl -s "${AUTH[@]}" -X PUT -H 'Content-Type: application/json' -d '[]' \
  "$API/workers/scripts/$NAME/schedules" | ok schedules   # cron на Cloudflare снят: сбор и выпуск — local.mjs
curl -s "${AUTH[@]}" -X POST -H 'Content-Type: application/json' -d '{"enabled":true}' \
  "$API/workers/scripts/$NAME/subdomain" | ok subdomain

printf 'url = "https://api.telegram.org/bot%s/setMyCommands"\n' "$BOT_TOKEN" > "$TGCFG"
node -e 'import("./worker.js").then(m => console.log(JSON.stringify({commands: m.COMMANDS.map(([command, description]) => ({command, description}))})))' |
  curl -s -K "$TGCFG" -H 'Content-Type: application/json' -d @- |
  python3 -c 'import json,sys; d=json.load(sys.stdin); d["ok"] or sys.exit("commands: " + str(d))'

# исполнитель на GCP: код, секреты, systemd
ssh "$HOST" mkdir -p tg-digest
scp -q worker.js local.mjs package.json "$HOST:tg-digest/"   # package.json: type=module, иначе node 18 грузит worker.js как CommonJS
for n in BOT_TOKEN GEMINI_API_KEY GEMINI_MODEL TARGET_CHAT OWNER_ID CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN PROXIES; do
  printf '%s=%s\n' "$n" "${!n}"
done | ssh "$HOST" 'sudo install -m 600 -o root /dev/stdin /etc/tg-digest.env'
ssh "$HOST" 'sudo tee /etc/systemd/system/tg-digest.service >/dev/null <<EOF
[Unit]
Description=tg-digest: сбор, выпуски и команды бота
After=network-online.target
Wants=network-online.target

[Service]
User=claude
WorkingDirectory=/home/claude/tg-digest
EnvironmentFile=/etc/tg-digest.env
ExecStart=/usr/bin/node local.mjs
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable -q tg-digest && sudo systemctl restart tg-digest'
echo "выложен: Worker $NAME (/notify), исполнитель $HOST (systemd tg-digest)"
