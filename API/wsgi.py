"""WSGI entry point for gunicorn and Docker: `gunicorn wsgi:app`."""
from dotenv import load_dotenv

load_dotenv()

from dealerpulse import create_app  # noqa: E402

app = create_app()