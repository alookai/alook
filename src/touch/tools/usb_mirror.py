import argparse
import errno
import fcntl
import http.server
import json
import os
import pathlib
import select
import struct
import termios
import threading
import time
import tty
import zlib
from collections import deque

HEADER = struct.Struct('<4sIIIHH4sI')
WIDTH = HEIGHT = 466
FRAME_BYTES = WIDTH * HEIGHT * 2


class FrameParser:
    def __init__(self):
        self.buffer = bytearray()
        self.rejected = 0

    def feed(self, data):
        self.buffer.extend(data)
        frames = []
        while True:
            start = self.buffer.find(b'ALM1')
            if start < 0:
                self.buffer[:] = self.buffer[-3:]
                break
            if start:
                del self.buffer[:start]
            if len(self.buffer) < HEADER.size:
                break
            magic, length, sequence, checksum, width, height, ip, flags = HEADER.unpack_from(self.buffer)
            if length != FRAME_BYTES or width != WIDTH or height != HEIGHT or flags & ~1:
                del self.buffer[0]
                self.rejected += 1
                continue
            size = HEADER.size + length
            if len(self.buffer) < size:
                break
            payload = self.buffer[HEADER.size:size]
            if zlib.crc32(payload) != checksum:
                del self.buffer[0]
                self.rejected += 1
                continue
            frames.append((bytes(self.buffer[:size]), sequence, '.'.join(map(str, ip)), bool(flags & 1)))
            del self.buffer[:size]
        return frames


def control_command(value):
    if not isinstance(value, dict):
        raise ValueError('Invalid input')
    kind = value.get('type')
    if kind == 'home' and set(value) == {'type'}:
        return b'H\n'
    if kind == 'record' and set(value) == {'type', 'down'} and type(value['down']) is bool:
        return f"R {int(value['down'])}\n".encode()
    if kind == 'wifi' and set(value) == {'type', 'ssid', 'password'}:
        if isinstance(value['ssid'], str) and isinstance(value['password'], str):
            ssid, password = value['ssid'].encode('utf-8'), value['password'].encode('utf-8')
            if 1 <= len(ssid) <= 32 and (not password or 8 <= len(password) <= 63) and b'\0' not in ssid + password:
                return f"W {ssid.hex()} {password.hex() if password else '-'}\n".encode()
    if kind == 'touch' and set(value) == {'type', 'x', 'y', 'down'}:
        if type(value['x']) is int and type(value['y']) is int and type(value['down']) is bool:
            if 0 <= value['x'] < WIDTH and 0 <= value['y'] < HEIGHT:
                return f"T {value['x']} {value['y']} {int(value['down'])}\n".encode()
    raise ValueError('Invalid input')


class Board:
    def __init__(self, port):
        self.port = port
        self.lock = threading.Lock()
        self.commands = deque(maxlen=128)
        self.frame = None
        self.frame_at = 0
        self.sequence = None
        self.connected = False
        self.error = None
        self.stop = threading.Event()

    def command(self, value):
        command = control_command(value)
        with self.lock:
            if not self.connected or time.monotonic() - self.frame_at > 4:
                raise ValueError('Board disconnected or frame is stale')
            if len(self.commands) == self.commands.maxlen:
                raise ValueError('Input queue is busy')
            self.commands.append(command)

    def snapshot(self):
        with self.lock:
            return self.frame, {
                'connected': self.connected,
                'sequence': self.sequence,
                'ageMs': round((time.monotonic() - self.frame_at) * 1000) if self.frame_at else None,
                'error': self.error,
            }

    def run(self):
        while not self.stop.is_set():
            fd = None
            try:
                fd = os.open(self.port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
                tty.setraw(fd, termios.TCSANOW)
                settings = termios.tcgetattr(fd)
                settings[2] |= termios.CLOCAL | termios.CREAD
                settings[2] &= ~termios.HUPCL
                settings[4] = settings[5] = termios.B115200
                termios.tcsetattr(fd, termios.TCSANOW, settings)
                try:
                    fcntl.ioctl(fd, termios.TIOCMBIC, struct.pack('I', termios.TIOCM_RTS))
                    fcntl.ioctl(fd, termios.TIOCMBIS, struct.pack('I', termios.TIOCM_DTR))
                except OSError as error:
                    if error.errno != errno.ENOTTY:
                        raise
                parser = FrameParser()
                pending = bytearray()
                requested_at = -float('inf')
                with self.lock:
                    self.commands.clear()
                    self.connected = True
                    self.error = None
                while not self.stop.is_set():
                    now = time.monotonic()
                    with self.lock:
                        while self.commands:
                            pending.extend(self.commands.popleft())
                        frame_at = self.frame_at
                    if now - requested_at >= 0.5 and (frame_at > requested_at or now - requested_at > 3):
                        pending.extend(b'F\n')
                        requested_at = now
                    reads, writes, _ = select.select([fd], [fd] if pending else [], [], 0.05)
                    if writes:
                        try:
                            count = os.write(fd, pending)
                            del pending[:count]
                        except BlockingIOError:
                            pass
                    if reads:
                        try:
                            data = os.read(fd, 65536)
                        except BlockingIOError:
                            continue
                        if not data:
                            raise OSError('USB disconnected')
                        for frame, sequence, _, _ in parser.feed(data):
                            with self.lock:
                                self.frame = frame
                                self.sequence = sequence
                                self.frame_at = time.monotonic()
            except OSError as error:
                with self.lock:
                    self.connected = False
                    self.commands.clear()
                    self.error = error.strerror or 'USB disconnected'
                self.stop.wait(1)
            finally:
                if fd is not None:
                    os.close(fd)
        with self.lock:
            self.connected = False


def handler_for(board, port):
    authority = f'127.0.0.1:{port}'
    origin = 'http://' + authority
    page = pathlib.Path(__file__).with_suffix('.html').read_bytes()

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def respond(self, status, body, content_type='application/json'):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.headers.get('Host') != authority:
                self.respond(403, b'{}')
            elif self.path == '/':
                self.respond(200, page, 'text/html; charset=utf-8')
            elif self.path == '/status':
                self.respond(200, json.dumps(board.snapshot()[1]).encode())
            elif self.path == '/frame':
                frame, status = board.snapshot()
                if frame is None or not status['connected'] or status['ageMs'] > 4000:
                    self.respond(503, b'{"error":"Waiting for a live board frame"}')
                else:
                    self.respond(200, frame, 'application/octet-stream')
            else:
                self.respond(404, b'{}')

        def do_POST(self):
            if self.headers.get('Host') != authority or self.headers.get('Origin') != origin:
                self.respond(403, b'{}')
                return
            if self.path != '/input':
                self.respond(404, b'{}')
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 1 <= length <= 512 or self.headers.get('Content-Type') != 'application/json':
                    raise ValueError('Invalid input')
                board.command(json.loads(self.rfile.read(length)))
            except (ValueError, UnicodeError):
                self.respond(400, b'{"error":"Input rejected"}')
                return
            self.respond(200, b'{"ok":true}')

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', required=True)
    parser.add_argument('--http-port', type=int, default=8776)
    args = parser.parse_args()
    board = Board(args.port)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', args.http_port), handler_for(board, args.http_port))
    worker = threading.Thread(target=board.run, daemon=True)
    worker.start()
    print(f'Live board viewer: http://127.0.0.1:{args.http_port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        board.stop.set()
        worker.join(timeout=2)
        server.server_close()


if __name__ == '__main__':
    main()
