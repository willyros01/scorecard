"""A stand-in for Firebase Authentication that never lets an account go.
Used only by test SEC5: the job must keep the deletion request when Firebase
does not confirm the account is gone."""
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

class Stuck(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        body = {"users": [{"localId": "still-here"}]} if self.path.endswith("accounts:lookup") else {}
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *args):
        pass

HTTPServer(("127.0.0.1", int(sys.argv[1])), Stuck).serve_forever()
