"""Validate raw runs, build the report into outputs/ and optionally publish it (--publish)."""

import subprocess
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
steps = ['validate.py', 'analyze.py', 'plot.py'] + (['publish.py'] if '--publish' in sys.argv else [])
passthrough = [arg for arg in sys.argv[1:] if arg != '--publish']
for step in steps:
    print(f'== {step}', flush=True)
    subprocess.run([sys.executable, str(TOOLS / step), *(passthrough if step == 'validate.py' else [])], check=True)
