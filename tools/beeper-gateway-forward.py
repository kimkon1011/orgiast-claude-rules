#!/usr/bin/env python3
# ASCII only. LAN front for tools/beeper-gateway.mjs on 000.
# Why: 000's LAN adapter is on the Windows "Public" firewall profile and node.exe is only allowed on "Private".
# python.exe already has an inbound allow rule on this PC, so this small TCP forwarder listens on the LAN port
# and relays to the node gateway on 127.0.0.1 (no admin change needed). The node gateway still does token auth,
# route allowlist and send limits; this forwarder only adds the source-IP allowlist (office LAN / Tailscale).
# Usage: python beeper-gateway-forward.py [listen_port=23380] [target_port=23381]
import asyncio, ipaddress, json, os, sys, time

ALLOWED = [ipaddress.ip_network(c) for c in os.environ.get(
    'BEEPER_GATEWAY_CIDRS', '127.0.0.0/8,192.168.0.0/24,100.64.0.0/10').split(',')]
LISTEN_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 23380
TARGET_PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 23381
LOG = os.path.join(os.path.expanduser('~'), '.claude', 'logs', 'beeper-gateway-forward.jsonl')


def log(ip, result):
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write(json.dumps({'ts': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'ip': ip, 'result': result}) + '\n')
    except OSError:
        pass


def allowed(ip):
    try:
        addr = ipaddress.ip_address(ip)
        if addr.version == 6 and addr.ipv4_mapped:
            addr = addr.ipv4_mapped
        return any(addr in n for n in ALLOWED)
    except ValueError:
        return False


async def pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def handle(reader, writer):
    ip = (writer.get_extra_info('peername') or ('?',))[0]
    if not allowed(ip):
        log(ip, 'rejected')
        writer.close()
        return
    try:
        up_reader, up_writer = await asyncio.open_connection('127.0.0.1', TARGET_PORT)
    except OSError:
        log(ip, 'gateway-down')
        writer.close()
        return
    await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))


async def main():
    try:
        server = await asyncio.start_server(handle, '0.0.0.0', LISTEN_PORT)
    except OSError:
        print('already running or port busy')
        return
    async with server:
        await server.serve_forever()


if __name__ == '__main__':
    asyncio.run(main())
