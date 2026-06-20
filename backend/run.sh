#!/usr/bin/env bash
# Launch the salescall-copilot backend with GPU Whisper + Twilio runtime env.
#
#   ./run.sh
#
# - Points LD_LIBRARY_PATH at the CUDA-12 cublas/cudnn wheels in the venv
#   (CTranslate2 4.7.x needs libcublas.so.12 + cuDNN 9; the system has CUDA 13).
# - Loads twilio.env (gitignored) into the process env — twilio_ws.py reads
#   TWILIO_*/PUBLIC_BASE_URL/TWILIO_STREAM_WSS from os.environ.
set -euo pipefail
cd "$(dirname "$0")"

VENV=/home/bonnietyler/conversation-copilot/backend/.venv

export LD_LIBRARY_PATH="$("$VENV/bin/python" -c 'import nvidia.cublas.lib as a, nvidia.cudnn.lib as b; print(a.__path__[0]+":"+b.__path__[0])')${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

if [ -f twilio.env ]; then
  set -a; source twilio.env; set +a
fi

exec "$VENV/bin/uvicorn" app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
