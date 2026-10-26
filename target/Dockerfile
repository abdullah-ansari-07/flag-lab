# Minimal lab target. It deliberately contains NO flags: /root/user.txt and
# /root/root.txt are injected per session by the orchestrator after
# `docker create` and before `docker start`. A real lab module would add its
# vulnerable service here.
FROM alpine:3.20
LABEL purpose="flag-lab target (flags injected at runtime, never baked in)"
RUN mkdir -p /root && chmod 700 /root
CMD ["tail", "-f", "/dev/null"]
