"""Список каналов дайджеста из папки Telegram → объект `channels` в R2 Worker'а tg-digest.
2026-10-03 22:43 · v1.2 · Nick Churkin

Читает папку (`TG_FOLDER`, по умолчанию «Bot») вашим аккаунтом через Telethon и кладёт в R2
юзернеймы публичных каналов из неё. Закрытые каналы и группы пропускает: лента t.me/s их не отдаёт.
Список не изменился — R2 не трогает.

    ~/.venvs/tg-digest/bin/python sync_channels.py           # синк (cron раз в сутки)
    ~/.venvs/tg-digest/bin/python sync_channels.py --dry     # показать список, R2 не трогать

Первый запуск спросит телефон и код из Telegram и сохранит сессию в `TG_SESSION`.
Сессия = доступ к аккаунту: файл только 600, в git и бэкапы проекта не класть.
"""
import asyncio
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

from telethon import TelegramClient
from telethon.tl.functions.messages import GetDialogFiltersRequest
from telethon.tl.types import Channel, DialogFilter, DialogFilterChatlist

def load_env() -> dict:
    """Настройки — секрет tg-digest в Bitwarden Secrets Manager (утилита ~/.local/bin/secret)."""
    text = subprocess.run(['secret', 'tg-digest'], capture_output=True, text=True, check=True).stdout
    env = {}
    for line in text.splitlines():
        key, sep, val = line.strip().partition('=')
        if sep and not key.startswith('#'):
            env[key.removeprefix('export ').strip()] = val.strip().strip('"\'')
    return env


def public_username(entity) -> str | None:
    """Юзернейм публичного канала (не группы); у каналов с несколькими именами — активное первое."""
    if not isinstance(entity, Channel) or not entity.broadcast:
        return None
    if entity.username:
        return entity.username
    return next((u.username for u in entity.usernames or [] if u.active), None)


async def folder_channels(client: TelegramClient, folder: str) -> tuple[list[str], list[str]]:
    res = await client(GetDialogFiltersRequest())
    filters = [f for f in res.filters if isinstance(f, (DialogFilter, DialogFilterChatlist))]
    match = next((f for f in filters if getattr(f.title, 'text', f.title) == folder), None)
    if match is None:
        names = ', '.join(getattr(f.title, 'text', f.title) for f in filters)
        raise SystemExit(f'папки «{folder}» нет; есть: {names}')

    entities = [await client.get_entity(p) for p in [*match.pinned_peers, *match.include_peers]]
    if getattr(match, 'broadcasts', False):  # в папке галка «Все каналы»
        excluded = {client.get_peer_id(p) for p in match.exclude_peers}
        entities += [d.entity async for d in client.iter_dialogs()
                     if d.is_channel and d.entity.broadcast and d.id not in excluded]

    names, skipped = [], []
    for e in entities:
        name = public_username(e)
        if name:
            names.append(name)
        else:
            skipped.append(getattr(e, 'title', None) or str(getattr(e, 'id', e)))
    return sorted(set(names), key=str.lower), skipped


def kv(env: dict, method: str, data: bytes | None = None) -> bytes:
    url = (f"https://api.cloudflare.com/client/v4/accounts/{env['CLOUDFLARE_ACCOUNT_ID']}"
           "/r2/buckets/tg-digest/objects/channels")
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={'Authorization': f"Bearer {env['CLOUDFLARE_API_TOKEN']}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        if method == 'GET' and e.code == 404:
            return b'[]'
        raise


async def main(dry: bool) -> None:
    env = load_env()
    session = Path(env.get('TG_SESSION', Path.home() / '.config/tg-digest/digest')).expanduser()
    session.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    async with TelegramClient(str(session), int(env['TG_API_ID']), env['TG_API_HASH']) as client:
        names, skipped = await folder_channels(client, env.get('TG_FOLDER', 'Bot'))
    os.chmod(f'{session}.session', 0o600)

    print(f'каналов: {len(names)}', *names, sep='\n  ')
    if skipped:
        print('пропущены (не публичные каналы):', *skipped, sep='\n  ')
    if dry:
        return
    if json.loads(kv(env, 'GET')) == names:
        print('R2 без изменений')
        return
    kv(env, 'PUT', json.dumps(names).encode())
    print('R2 channels обновлён')


if __name__ == '__main__':
    asyncio.run(main('--dry' in sys.argv))
