# Decoders that are not installed on the Mac. They reach the dongle through rtl_tcp (osmocom rtl-sdr)
# running on the host: the container never touches USB (Docker Desktop on macOS cannot).
#
#   docker build -t rtlsdr-decoders docker/decoders
#   rtl_tcp -a 0.0.0.0 -p 1234 &                       # on the Mac (owns the dongle)
#   docker run --rm -p 7979:7979 rtlsdr-decoders welle-cli -D rtl_tcp -H host.docker.internal:1234 -c 11B -w 7979
#
# Included: welle-cli (DAB/DAB+), rtl-sdr client tools (osmocom), rtl_433 (rtl_tcp input), dumpvdl2-free tools.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      welle.io \
      rtl-sdr \
      rtl-433 \
      ca-certificates \
      curl \
 && rm -rf /var/lib/apt/lists/*

# rtl_tcp server on the host, seen from the container
ENV RTL_TCP_HOST=host.docker.internal
ENV RTL_TCP_PORT=1234

EXPOSE 7979
CMD ["welle-cli", "--help"]
