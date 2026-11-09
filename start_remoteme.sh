#!/usr/bin/env bash
cd "$(dirname "$0")"

echo "===================================================================="
echo "  🚀 Starting SIAM RemoteMe Studio (Cross-Platform 60 FPS Engine)"
echo "===================================================================="

if ! command -v python3 &> /dev/null; then
    echo "Python 3 is required. Please install Python 3."
    exit 1
fi

python3 -m pip install -r requirements.txt --quiet

python3 server.py &
SERVER_PID=$!
sleep 2

if command -v xdg-open &> /dev/null; then
    xdg-open "http://localhost:8765"
elif command -v open &> /dev/null; then
    open "http://localhost:8765"
fi

wait $SERVER_PID
