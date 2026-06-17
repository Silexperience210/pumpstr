/**
 * signaling.ts — signaling WebRTC pour le « go live » P2P de Pumpstr.
 *
 * Le node ne touche JAMAIS les médias : il ne fait que relayer les SDP (offer/
 * answer) et les candidats ICE entre LE broadcaster (le créateur, dans le Studio)
 * et les viewers (watch.html), sur le même WebSocket `/ws` que les tips. Le flux
 * vidéo/audio passe directement de pair à pair (souverain, pas de CDN).
 *
 * Modèle : 1 broadcaster, N viewers. Routage broadcaster→viewer par `to:<id>` ;
 * viewer→broadcaster implicite (un seul broadcaster). Pur & testable : `broadcastAll`
 * (diffusion live-started/ended à tous les clients /ws) est injecté.
 */
type WsLike = { send: (s: string) => void; readyState: number };

export function createSignaling(broadcastAll: (msg: any) => void) {
  let broadcaster: WsLike | null = null;
  const viewers = new Map<string, WsLike>();
  const ids = new WeakMap<WsLike, string>();
  let seq = 0;

  const send = (ws: WsLike | null | undefined, msg: any) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  const idFor = (ws: WsLike) => { let id = ids.get(ws); if (!id) { id = "v" + (++seq); ids.set(ws, id); } return id; };

  function onMessage(ws: WsLike, m: any) {
    if (!m || typeof m.type !== "string") return;
    switch (m.type) {
      case "golive": // le créateur passe en direct ; (re)déclenche le handshake avec les viewers présents
        broadcaster = ws;
        for (const [vid] of viewers) send(broadcaster, { type: "viewer-join", from: vid });
        broadcastAll({ type: "live-started" });
        break;
      case "endlive":
        if (ws === broadcaster) { broadcaster = null; broadcastAll({ type: "live-ended" }); }
        break;
      case "join": { // un viewer veut le flux
        const vid = idFor(ws); viewers.set(vid, ws);
        if (broadcaster) send(broadcaster, { type: "viewer-join", from: vid });
        else send(ws, { type: "no-live" });
        break;
      }
      case "offer": // broadcaster -> viewer ciblé
        if (ws === broadcaster && m.to) send(viewers.get(m.to), { type: "offer", sdp: m.sdp });
        break;
      case "answer": // viewer -> broadcaster
        send(broadcaster, { type: "answer", from: idFor(ws), sdp: m.sdp });
        break;
      case "ice": // candidats des deux côtés
        if (ws === broadcaster && m.to) send(viewers.get(m.to), { type: "ice", candidate: m.candidate });
        else if (ws !== broadcaster) send(broadcaster, { type: "ice", from: idFor(ws), candidate: m.candidate });
        break;
    }
  }

  function detach(ws: WsLike) {
    if (ws === broadcaster) { broadcaster = null; broadcastAll({ type: "live-ended" }); return; }
    const id = ids.get(ws);
    if (id && viewers.delete(id)) send(broadcaster, { type: "viewer-leave", from: id });
  }

  return {
    onMessage,
    detach,
    isLive: () => !!broadcaster,
    viewerCount: () => viewers.size,
  };
}
