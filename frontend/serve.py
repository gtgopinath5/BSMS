#!/usr/bin/env python3
# Dev server for the Baywatch Service OS frontend.
# Sends no-cache headers so edited .jsx/.css files are always reloaded
# (the in-browser Babel transform otherwise serves stale cached scripts).
#
#   python3 serve.py
#   -> http://localhost:7890/
#
import http.server, socketserver, os

PORT = 7890
ROOT = os.path.dirname(os.path.abspath(__file__))   # always serve this folder


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, *args):
        pass  # quiet

    def translate_path(self, path):
        # Redirect bare / to index.html
        if path in ('', '/', '/%20', '/index'):
            path = '/index.html'
        return super().translate_path(path)


if __name__ == '__main__':
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('', PORT), NoCacheHandler) as httpd:
        print(f'Baywatch frontend (no-cache) on http://localhost:{PORT}/')
        httpd.serve_forever()
