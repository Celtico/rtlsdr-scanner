#!/bin/sh
# Proves that the decoders inside the rtlsdr-decoders image really decode.
# nexus_th.cu8 is a synthetic Nexus-TH frame (id 90, 21.7 °C, 55 %) as 250 kS/s 8-bit IQ.
#   sh docker/decoders/selftest/run.sh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "== rtl_433 (Docker) decoding a Nexus-TH frame from a file:"
OUT="$(docker run --rm -v "$DIR/nexus_th.cu8:/data/nexus_th.cu8:ro" rtlsdr-decoders rtl_433 -r /data/nexus_th.cu8 -s 250k -F json 2>/dev/null | head -1)"
echo "$OUT"
echo "$OUT" | grep -q '"model" : "Nexus-TH"' && echo "$OUT" | grep -q '"temperature_C" : 21.700' && echo "OK: rtl_433 decodes" || { echo "FAIL"; exit 1; }
echo "== welle-cli (Docker) version:"
docker run --rm rtlsdr-decoders welle-cli -v 2>&1 | head -1
echo "Live test: rtl_tcp -a 0.0.0.0 -p 1234 on the Mac, then 'docker compose run --rm rtl433' and press a 433 MHz remote."
