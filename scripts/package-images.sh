#!/usr/bin/env sh
# Builds both images and exports them as ONE tarball you can send to the company.
#   sh scripts/package-images.sh   ->  flag-system-images.tar.gz
set -eu
cd "$(dirname "$0")/.."
docker build -t flag-lab-target:latest ./target
docker build -t dynamic-flag-system:latest .
docker save dynamic-flag-system:latest flag-lab-target:latest | gzip > flag-system-images.tar.gz
echo "Created flag-system-images.tar.gz"
echo "Recipient:  gunzip -c flag-system-images.tar.gz | docker load"
echo "            (then use docker-compose.yml + a .env:  docker compose up --no-build)"
