export function startCdpProxy(hostname: string, port: number, upstreamPort: number): Bun.TCPSocketListener<undefined> {
  const cdpPeers = new WeakMap<Bun.Socket, Bun.Socket>();
  function closePeer(socket: Bun.Socket): void {
    const peer = cdpPeers.get(socket);
    cdpPeers.delete(socket);
    if (peer) {
      cdpPeers.delete(peer);
      peer.end();
    }
  }
  return Bun.listen({
    hostname,
    port,
    socket: {
      open(client) {
        client.pause();
        void Bun.connect({
          hostname: "127.0.0.1",
          port: upstreamPort,
          socket: {
            open(upstream) {
              cdpPeers.set(client, upstream);
              cdpPeers.set(upstream, client);
              client.resume();
            },
            data(upstream, data) {
              cdpPeers.get(upstream)?.write(data);
            },
            close: closePeer,
            error: closePeer,
          },
        }).catch(() => client.end());
      },
      data(client, data) {
        cdpPeers.get(client)?.write(data);
      },
      close: closePeer,
      error: closePeer,
    },
  });

}

export type VncPeer = { socket?: Bun.Socket<VncPeer> };
export const vncWebSocket: Bun.WebSocketHandler<VncPeer> = {
  open(webSocket) {
    void Bun.connect<VncPeer>({
      hostname: "127.0.0.1",
      port: 5900,
      socket: {
        open(socket) {
          webSocket.data.socket = socket;
        },
        data(_socket, data) {
          webSocket.send(data);
        },
        close() {
          webSocket.close();
        },
        error(_socket, error) {
          webSocket.close(1011, error.message);
        },
      },
    });
  },
  message(webSocket, message) {
    webSocket.data.socket?.write(typeof message === "string" ? new TextEncoder().encode(message) : message);
  },
  close(webSocket) {
    webSocket.data.socket?.end();
  },
};
