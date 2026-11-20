#!/usr/bin/env python3
"""restart-watch: supervisord event listener behind the BCP container restart (10.4.2).

The api-gateway runs as user node and can neither signal supervisord (root) nor
use its root-only control socket. The channel between them is a request file
carrying a per-boot secret — NOT the api-gateway's stdout: anything the gateway
logs can contain attacker-controlled text (a login e-mail, a path, a header),
and supervisor's stdout capture mode would turn such text into events (and an
injected BEGIN marker alone would swallow every following log line).

  start  this listener generates a random secret (32 bytes, hex) and writes it to
         TOKEN_FILE (root:node 0440 when running as root, else 0400); a request
         file left over from before the start is deleted.
  POST   /api/v1/admin/servers/restart → the api-gateway writes the secret into
         REQUEST_FILE (packages/api-gateway/src/lib/server-restart.ts).
  TICK_5 (every 5 s) this listener reads and deletes REQUEST_FILE (no symlinks,
         regular files only, at most 256 bytes) and compares it in constant time
         (hmac.compare_digest). Match → SIGTERM to supervisord: every program
         stops gracefully, supervisord and tini exit, the container's restart
         policy starts it again (a new secret on the next start). At most one
         accepted request per COOLDOWN_SECONDS; every rejected request is logged
         without its content. The secret is never logged.
"""
import hmac
import os
import secrets
import signal
import stat
import sys
import time

RUN_DIR = os.environ.get('COREMAIL_RESTART_DIR', '/var/run/supervisor')
TOKEN_FILE = os.path.join(RUN_DIR, 'restart.token')
REQUEST_FILE = os.path.join(RUN_DIR, 'restart.request')
COOLDOWN_SECONDS = 120
MAX_REQUEST_BYTES = 256
READER_USER = 'node'


def log(msg):
    sys.stderr.write('restart-watch: %s\n' % msg)
    sys.stderr.flush()


def remove(path):
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


def write_token(token_file=TOKEN_FILE, request_file=REQUEST_FILE):
    """New per-boot secret; readable by the api-gateway's user, writable by nobody else."""
    token = secrets.token_hex(32)
    remove(request_file)  # never act on a request from before this start
    tmp = '%s.%d.tmp' % (token_file, os.getpid())
    remove(tmp)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o400)
    try:
        os.write(fd, token.encode('ascii'))
        if os.geteuid() == 0:
            import pwd
            os.fchown(fd, 0, pwd.getpwnam(READER_USER).pw_gid)
            os.fchmod(fd, 0o440)
    finally:
        os.close(fd)
    os.replace(tmp, token_file)
    return token


def read_request(path=REQUEST_FILE):
    """Content of the request file (bytes) and deletes it; None when there is none.

    Raises ValueError for something that is not a regular file (symlink, FIFO …).
    """
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    except FileNotFoundError:
        return None
    except OSError:
        remove(path)
        raise ValueError('not a regular file')
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError('not a regular file')
        return os.read(fd, MAX_REQUEST_BYTES + 1)
    finally:
        os.close(fd)
        remove(path)


class Watch:
    def __init__(self, token, now=time.monotonic, cooldown=COOLDOWN_SECONDS):
        self.token = token.encode('ascii')
        self.now = now
        self.cooldown = cooldown
        self.last_accepted = None

    def check(self, path=REQUEST_FILE):
        """'none' | 'accept' | 'reject:<reason>' | 'cooldown' — never includes the request content."""
        try:
            data = read_request(path)
        except ValueError as err:
            return 'reject:%s' % err
        if data is None:
            return 'none'
        if len(data) > MAX_REQUEST_BYTES:
            return 'reject:oversized (%d+ bytes)' % MAX_REQUEST_BYTES
        if not hmac.compare_digest(data.strip(), self.token):
            return 'reject:wrong secret (%d bytes)' % len(data)
        t = self.now()
        if self.last_accepted is not None and t - self.last_accepted < self.cooldown:
            return 'cooldown'
        self.last_accepted = t
        return 'accept'


def parse_tokens(line):
    return dict(part.split(':', 1) for part in line.split() if ':' in part)


def main():
    token = write_token()
    log('ready (secret rotated)')
    watch = Watch(token)
    stdin, stdout = sys.stdin.buffer, sys.stdout
    while True:
        stdout.write('READY\n')
        stdout.flush()
        line = stdin.readline()
        if not line:
            return  # EOF: supervisord is gone
        header = parse_tokens(line.decode('utf-8', 'replace'))
        stdin.read(int(header.get('len', '0')))  # the event payload is not needed
        verdict = watch.check()
        stdout.write('RESULT 2\nOK')
        stdout.flush()
        if verdict == 'accept':
            log('restart requested by the api-gateway - stopping supervisord (pid %d)' % os.getppid())
            os.kill(os.getppid(), signal.SIGTERM)
        elif verdict == 'cooldown':
            log('ignored a valid restart request: one restart per %d s' % COOLDOWN_SECONDS)
        elif verdict.startswith('reject:'):
            log('REJECTED a restart request: %s' % verdict[len('reject:'):])


if __name__ == '__main__':
    main()
