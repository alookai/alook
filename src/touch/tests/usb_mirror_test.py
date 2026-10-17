import http.client
import importlib.util
import json
import os
import pathlib
import pty
import select
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import unittest
import zlib

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'tools/usb_mirror.py'
spec = importlib.util.spec_from_file_location('touch_usb_bridge', SOURCE)
mirror = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mirror)


def frame(sequence=1, pixels=None):
    pixels = pixels if pixels is not None else b'\x00\xf8' * (466 * 466)
    return mirror.HEADER.pack(b'ALM3', len(pixels), sequence, zlib.crc32(pixels), 466, 466, bytes([10, 0, 0, 2]), 1, 1, 0, -1, 0, 0, 12000, 113, 3, bytes([255, 255, 248, 0]), bytes([10, 0, 0, 1]), bytes([1, 1, 1, 1]), bytes(4), bytes([10, 0, 0, 9]), -57, 6, 3, 3000, 118, -7, 0, 32774, -1) + pixels


class Frames(unittest.TestCase):
    def test_native_wire_layout_and_fragmented_noise(self):
        parser = mirror.FrameParser()
        data = b'ROM boot message\n' + frame(73)
        frames = []
        for index in range(0, len(data), 97):
            frames.extend(parser.feed(data[index:index + 97]))
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0], (data[17:], 73, '10.0.0.2', True))
        self.assertEqual(mirror.HEADER.size, 116)

    def test_corrupt_and_impossible_frames_recover_to_next_full_frame(self):
        parser = mirror.FrameParser()
        bad = bytearray(frame(1)); bad[-1] ^= 1
        oversized = mirror.HEADER.pack(b'ALM3', 0xffffffff, 2, 0, 466, 466, bytes(4), 0, *([0] * 8), *([bytes(4)] * 5), *([0] * 9))
        self.assertEqual([item[1] for item in parser.feed(bad + oversized + frame(3))], [3])
        self.assertGreaterEqual(parser.rejected, 2)
        self.assertLessEqual(len(parser.buffer), 3)

    def test_input_is_bounded_and_cannot_inject_serial_commands(self):
        self.assertEqual(mirror.control_command({'type': 'touch', 'x': 465, 'y': 0, 'down': True}), b'T 465 0 1\n')
        self.assertEqual(mirror.control_command({'type': 'record', 'down': False}), b'R 0\n')
        for value in [None, {'type': 'home\nR 1'}, {'type': 'home', 'extra': 1}, {'type': 'touch', 'x': -1, 'y': 0, 'down': True}, {'type': 'touch', 'x': 466, 'y': 0, 'down': True}, {'type': 'touch', 'x': True, 'y': 0, 'down': True}, {'type': 'record', 'down': 1}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                mirror.control_command(value)

    def test_wifi_values_are_bounded_and_encoded_without_line_injection(self):
        self.assertEqual(mirror.control_command({'type': 'wifi', 'ssid': 'test', 'password': 'password'}), b'W 74657374 70617373776f7264\n')
        self.assertEqual(mirror.control_command({'type': 'wifi', 'ssid': 'open', 'password': ''}), b'W 6f70656e -\n')
        command = mirror.control_command({'type': 'wifi', 'ssid': 'test\nH', 'password': 'password'})
        self.assertEqual(command.count(b'\n'), 1)
        for ssid, password in [('', ''), ('x' * 33, ''), ('test', 'short'), ('test', 'x' * 64), ('test\0other', 'password')]:
            with self.subTest(ssid=ssid), self.assertRaises(ValueError):
                mirror.control_command({'type': 'wifi', 'ssid': ssid, 'password': password})


class NativeBridge(unittest.TestCase):
    def test_actual_viewer_script_retires_held_input_on_disconnect(self):
        subprocess.run(['node', str(pathlib.Path(__file__).with_name('usb_mirror_browser.cjs'))], check=True)

    def test_default_off_compiles_without_transport_or_framebuffer(self):
        root = SOURCE.parents[1]
        compiler = shutil.which('clang++') or shutil.which('g++')
        self.assertIsNotNone(compiler)
        with tempfile.TemporaryDirectory(prefix='alook-touch-usb-off-') as directory:
            path = pathlib.Path(directory)
            for name in ['usb_mirror.cpp', 'usb_mirror.h', 'configuration.h']:
                shutil.copyfile(root / 'firmware/touch' / name, path / name)
            (path / 'main.cpp').write_text('#include "usb_mirror.h"\n#include <cassert>\nint main(){assert(alook_touch::usb_mirror_begin());alook_touch::usb_mirror_tick();assert(!alook_touch::usb_mirror_record());assert(!alook_touch::usb_mirror_home());}\n')
            subprocess.run([compiler, '-std=c++17', '-Wall', '-Wextra', '-Werror', '-I' + str(root / '.cache/sketchbook/libraries/lvgl'), str(path / 'usb_mirror.cpp'), str(path / 'main.cpp'), '-o', str(path / 'disabled')], check=True)
            subprocess.run([str(path / 'disabled')], check=True)
            symbols = subprocess.check_output(['nm', str(path / 'disabled')], text=True)
            for name in ['heap_caps', 'Serial', 'UsbMirrorInput', 'esp_rom_crc', 'usb_mirror_flush']:
                self.assertNotIn(name, symbols)

    def test_real_posix_serial_frame_and_http_controls(self):
        master, slave = pty.openpty()
        board = mirror.Board(os.ttyname(slave))
        worker = threading.Thread(target=board.run, daemon=True)
        server = mirror.http.server.ThreadingHTTPServer(('127.0.0.1', 0), mirror.handler_for(board, 0))
        port = server.server_address[1]
        server.RequestHandlerClass = mirror.handler_for(board, port)
        http_thread = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start(); http_thread.start()
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
        try:
            deadline = time.monotonic() + 3
            requested = b''
            while b'F\n' not in requested and time.monotonic() < deadline:
                if select.select([master], [], [], .1)[0]:
                    requested += os.read(master, 4096)
            self.assertIn(b'F\n', requested)
            data = frame(9)
            sent = 0
            while sent < len(data):
                sent += os.write(master, data[sent:sent + 2048])
            while board.snapshot()[1]['sequence'] != 9 and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertEqual(board.snapshot()[1]['sequence'], 9)
            self.assertEqual(board.snapshot()[1]['httpDiagnostic'], {'attempt':1, 'operation':0, 'nativeError':-1, 'httpStatus':0, 'bodyBytes':0, 'elapsedMs':12000, 'socketErrno':113, 'stage':3, 'targetAddress':'10.0.0.9', 'targetPort':3000, 'systemErrno':118, 'tlsError':-7, 'tlsFlags':0, 'tlsCode':32774, 'socket':-1})
            self.assertEqual(board.snapshot()[1]['network'], {'address':'10.0.0.2', 'subnetMask':'255.255.248.0', 'gateway':'10.0.0.1', 'dns1':'1.1.1.1', 'dns2':'0.0.0.0', 'rssi':-57, 'channel':6, 'wifiStatus':3})
            connection.request('GET', '/status')
            response = connection.getresponse()
            status = json.loads(response.read())
            self.assertEqual(response.status, 200)
            self.assertEqual(status['network'], board.snapshot()[1]['network'])
            self.assertEqual(status['httpDiagnostic'], board.snapshot()[1]['httpDiagnostic'])
            connection.request('GET', '/frame')
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader('Cache-Control'), 'no-store')
            self.assertEqual(response.read(), data)
            body = json.dumps({'type': 'home'})
            for origin, status in [('http://attacker.invalid', 403), (f'http://127.0.0.1:{port}', 200)]:
                connection.request('POST', '/input', body, {'Origin': origin, 'Content-Type': 'application/json'})
                response = connection.getresponse(); response.read()
                self.assertEqual(response.status, status)
            received = b''
            deadline = time.monotonic() + 2
            while b'H\n' not in received and time.monotonic() < deadline:
                if select.select([master], [], [], .1)[0]:
                    received += os.read(master, 4096)
            self.assertIn(b'H\n', received)
            with board.lock:
                board.frame_at = time.monotonic() - 5
            connection.request('GET', '/frame')
            response = connection.getresponse(); response.read()
            self.assertEqual(response.status, 503)
            connection.request('POST', '/input', body, {'Origin': f'http://127.0.0.1:{port}', 'Content-Type': 'application/json'})
            response = connection.getresponse(); response.read()
            self.assertEqual(response.status, 400)
            connection.request('GET', '/', headers={'Host': 'attacker.invalid'})
            response = connection.getresponse(); response.read()
            self.assertEqual(response.status, 403)
        finally:
            connection.close(); board.stop.set(); worker.join(timeout=2)
            server.shutdown(); server.server_close(); http_thread.join(timeout=2)
            os.close(master); os.close(slave)


if __name__ == '__main__':
    unittest.main()
