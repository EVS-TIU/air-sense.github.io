#!/usr/bin/env python3
"""AIR_SENSE development launcher.

Starts the FastAPI backend (uvicorn) and the static frontend on one command:

    python3 run.py

By default it opens the frontend in your browser once both servers are up.

Optional flags:
    --backend-port 8000    backend port (env: PORT)
    --frontend-port 5500   frontend port
    --reload               auto-reload the backend on code changes
    --no-open              do not open a browser window
    --install              pip install backend/requirements.txt first
"""

from __future__ import annotations

import argparse
import os
import shutil
import socket
import subprocess
import sys
import threading
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND_DIR = ROOT / "backend"
FRONTEND_DIR = ROOT / "frontend"
REQUIRED_MODULES = ("fastapi", "uvicorn", "pydantic_settings")


def port_is_free(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
        except OSError:
            return False
        return True


def missing_modules() -> list[str]:
    missing = []
    for module in REQUIRED_MODULES:
        try:
            __import__(module)
        except ImportError:
            missing.append(module)
    return missing


def venv_python() -> Path | None:
    candidates = (
        ROOT / ".venv" / "bin" / "python",
        ROOT / ".venv" / "Scripts" / "python.exe",
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def use_project_venv() -> None:
    """Re-exec with .venv/bin/python when the current interpreter lacks deps."""
    if not missing_modules():
        return
    candidate = venv_python()
    if candidate is None:
        return
    # A venv's python symlink often resolves to the base interpreter, so
    # compare against sys.prefix rather than the resolved executable path.
    if Path(sys.prefix).resolve() == (ROOT / ".venv").resolve():
        return
    print(f"Using project virtualenv: {candidate}", flush=True)
    os.execv(str(candidate), [str(candidate), str(Path(__file__).resolve()), *sys.argv[1:]])


def check_dependencies() -> None:
    missing = missing_modules()
    if missing:
        print(f"Missing backend dependencies: {', '.join(missing)}")
        print("Install them with:")
        print(f"  {sys.executable} -m pip install -r {BACKEND_DIR / 'requirements.txt'}")
        print("or rerun with:  python3 run.py --install")
        raise SystemExit(1)


def install_requirements() -> None:
    print("Installing backend requirements...")
    uv = shutil.which("uv")
    if uv:
        command = [uv, "pip", "install", "--python", sys.executable,
                   "-r", str(BACKEND_DIR / "requirements.txt")]
    else:
        command = [sys.executable, "-m", "pip", "install",
                   "-r", str(BACKEND_DIR / "requirements.txt")]
    subprocess.check_call(command)


class QuietHandler(SimpleHTTPRequestHandler):
    """Static handler with no request spam and no-cache for dev."""

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        pass


def start_frontend(port: int) -> ThreadingHTTPServer:
    handler = partial(QuietHandler, directory=str(FRONTEND_DIR))
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    except OSError as exc:
        print(f"Could not start frontend on port {port}: {exc}")
        print(f"Try another port, e.g. python3 run.py --frontend-port {port + 1}")
        raise SystemExit(1)
    thread = threading.Thread(target=server.serve_forever, name="frontend", daemon=True)
    thread.start()
    return server


def main() -> None:
    parser = argparse.ArgumentParser(description="Run AIR_SENSE backend + frontend locally.")
    parser.add_argument(
        "--backend-port",
        type=int,
        default=int(os.getenv("PORT", "8000")),
        help="backend port (default: 8000 / $PORT)",
    )
    parser.add_argument(
        "--frontend-port", type=int, default=5500, help="frontend port (default: 5500)"
    )
    parser.add_argument("--reload", action="store_true", help="auto-reload backend on changes")
    parser.add_argument("--no-open", action="store_true", help="do not open the frontend in a browser")
    parser.add_argument("--install", action="store_true", help="install backend requirements first")
    args = parser.parse_args()

    use_project_venv()

    if args.install:
        install_requirements()

    if not FRONTEND_DIR.is_dir():
        print(f"Frontend directory not found: {FRONTEND_DIR}")
        raise SystemExit(1)

    check_dependencies()

    if not port_is_free(args.backend_port):
        print(f"Backend port {args.backend_port} is already in use.")
        print("Stop the other process or pick a port: python3 run.py --backend-port 8001")
        raise SystemExit(1)

    frontend = start_frontend(args.frontend_port)

    # uvicorn resolves "app.main:app" from the backend directory.
    os.chdir(BACKEND_DIR)
    sys.path.insert(0, str(BACKEND_DIR))

    import uvicorn

    frontend_url = f"http://127.0.0.1:{args.frontend_port}"
    backend_url = f"http://127.0.0.1:{args.backend_port}"

    print()
    print("  AIR_SENSE is running")
    print(f"  Frontend : {frontend_url}")
    print(f"  Backend  : {backend_url}  (docs: {backend_url}/docs)")
    print("  Press Ctrl+C to stop.")
    print()

    if not args.no_open:
        threading.Timer(1.5, webbrowser.open, args=(frontend_url,)).start()

    try:
        uvicorn.run(
            "app.main:app",
            host="127.0.0.1",
            port=args.backend_port,
            reload=args.reload,
            reload_dirs=[str(BACKEND_DIR / "app")] if args.reload else None,
            log_level="info",
        )
    except KeyboardInterrupt:
        pass
    finally:
        frontend.shutdown()
        frontend.server_close()
        print("\nAIR_SENSE stopped.")


if __name__ == "__main__":
    main()
