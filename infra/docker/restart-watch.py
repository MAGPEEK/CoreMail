#!/usr/bin/env python3
"""restart-watch: supervisord event listener for the BCP container restart (10.4.2).

The api-gateway runs as user node and cannot signal supervisord (root) or use
its root-only control socket. To restart the container it writes a capture-mode
token to its stdout (packages/api-gateway/src/lib/server-restart.ts):

    <!--XSUPERVISOR:BEGIN-->coremail:restart-container<!--XSUPERVISOR:END-->

supervisord turns that into a PROCESS_COMMUNICATION_STDOUT event. This listener
(root, see [eventlistener:restart-watch] in supervisord-app.conf) accepts it only
from the program "api-gateway" and only with exactly that token, then sends
SIGTERM to supervisord: every program is stopped gracefully, supervisord exits,
tini exits, the container stops and its restart policy starts it again.
Every other event is acknowledged and ignored.
"""
import os
import signal
import sys

TOKEN = 'coremail:restart-container'
ALLOWED_PROCESS = 'api-gateway'


def log(msg):
    sys.stderr.write('restart-watch: %s\n' % msg)
    sys.stderr.flush()


def parse_tokens(line):
    return dict(part.split(':', 1) for part in line.split() if ':' in part)


def read_event(stdin):
    # `len` counts bytes: read the binary stream, decode leniently.
    header = parse_tokens(stdin.readline().decode('utf-8', 'replace'))
    payload = stdin.read(int(header.get('len', '0'))).decode('utf-8', 'replace')
    return header, payload


def is_restart_request(header, payload):
    if header.get('eventname') != 'PROCESS_COMMUNICATION_STDOUT':
        return False
    first, _, data = payload.partition('\n')
    meta = parse_tokens(first)
    return meta.get('processname') == ALLOWED_PROCESS and data.strip() == TOKEN


def main():
    stdin, stdout = sys.stdin.buffer, sys.stdout
    while True:
        stdout.write('READY\n')
        stdout.flush()
        header, payload = read_event(stdin)
        restart = is_restart_request(header, payload)
        stdout.write('RESULT 2\nOK')
        stdout.flush()
        if restart:
            log('restart requested by the api-gateway - stopping supervisord (pid %d)' % os.getppid())
            os.kill(os.getppid(), signal.SIGTERM)


if __name__ == '__main__':
    main()
