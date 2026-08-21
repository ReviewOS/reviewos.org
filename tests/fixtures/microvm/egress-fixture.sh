#!/bin/sh
# Two destinations a job must never reach, and one it may.
#
# The adversarial egress tests need somewhere to *fail* to connect to. Pointing
# them at a real metadata endpoint proves nothing on a machine that has none:
# unreachable-because-absent and unreachable-because-refused look identical from
# inside a guest, and a test that cannot tell them apart is a test of nothing.
#
# So this builds the destinations. A network namespace stands in for the rest of
# the world and holds two addresses:
#
#   169.254.169.254  the cloud metadata endpoint, which hands out a machine's
#                    credentials to anything that asks
#   198.51.100.10    an ordinary registry, which an operator would allowlist
#
# Both are reached by *routing*, which is what makes the test meaningful: a guest
# reaching them would be the host forwarding its packets, exactly as it would on
# a real network. The host proves it can reach both before any guest is booted,
# so a later failure is the policy rather than a fixture that was never up.
#
# Root, and idempotent: run it as many times as you like.
set -e

NS=rvos-egress
HOST_SIDE=rvosveth
NS_SIDE=rvosvpeer

ip netns delete "$NS" 2>/dev/null || true
ip link delete "$HOST_SIDE" 2>/dev/null || true

ip netns add "$NS"
ip link add "$HOST_SIDE" type veth peer name "$NS_SIDE"
ip link set "$NS_SIDE" netns "$NS"

ip addr add 172.30.0.1/30 dev "$HOST_SIDE"
ip link set "$HOST_SIDE" up

ip netns exec "$NS" ip addr add 172.30.0.2/30 dev "$NS_SIDE"
ip netns exec "$NS" ip link set "$NS_SIDE" up
ip netns exec "$NS" ip link set lo up
ip netns exec "$NS" ip addr add 169.254.169.254/32 dev "$NS_SIDE"
ip netns exec "$NS" ip addr add 198.51.100.10/32 dev "$NS_SIDE"
ip netns exec "$NS" ip route add default via 172.30.0.1

ip route replace 169.254.169.254/32 via 172.30.0.2
ip route replace 198.51.100.10/32 via 172.30.0.2

sysctl -w net.ipv4.ip_forward=1 >/dev/null

cat > /tmp/rvos-egress-serve.py <<'PY'
import socket, threading

def serve(addr, body):
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((addr, 80))
    s.listen(16)
    while True:
        c, _ = s.accept()
        try:
            c.recv(1024)
            c.sendall(b"HTTP/1.0 200 OK\r\nContent-Length: %d\r\n\r\n%s" % (len(body), body))
        except Exception:
            pass
        finally:
            c.close()

threading.Thread(target=serve, args=("169.254.169.254", b"METADATA-CREDENTIALS"), daemon=True).start()
serve("198.51.100.10", b"REGISTRY-OK")
PY

# The listeners outlive this script, so the test can boot a guest against them.
if command -v systemd-run >/dev/null 2>&1; then
  systemctl stop rvos-egress 2>/dev/null || true
  systemd-run --unit=rvos-egress --collect ip netns exec "$NS" python3 /tmp/rvos-egress-serve.py >/dev/null
else
  pkill -f rvos-egress-serve.py 2>/dev/null || true
  setsid nohup ip netns exec "$NS" python3 /tmp/rvos-egress-serve.py >/dev/null 2>&1 < /dev/null &
fi

# Not "started" - *answering*. A fixture reported up before it accepts a
# connection is a race the test would blame on the policy.
for _ in $(seq 1 40); do
  if curl -s --max-time 1 http://198.51.100.10/ >/dev/null 2>&1; then
    echo ready
    exit 0
  fi
  sleep 0.25
done

echo "the fixture did not come up" >&2
exit 1
