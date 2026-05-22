#!/usr/bin/env python3
"""Local dev server that mimics Vercel rewrites (/app -> /app.html)."""
import http.server, socketserver, os, sys

PORT = 5500
ROOT = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # No caching during dev
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        super().end_headers()

    def do_GET(self):
        # Strip query string for routing
        path = self.path.split('?', 1)[0]
        # Vercel rewrites
        if path == '/app':
            self.path = '/app.html' + (('?' + self.path.split('?', 1)[1]) if '?' in self.path else '')
        return super().do_GET()

if __name__ == '__main__':
    with socketserver.TCPServer(('127.0.0.1', PORT), Handler) as httpd:
        httpd.allow_reuse_address = True
        print(f'Serving {ROOT} at http://localhost:{PORT}/', flush=True)
        httpd.serve_forever()
