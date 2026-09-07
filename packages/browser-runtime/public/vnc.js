import RFB from "/novnc/core/rfb.js";

const protocol = location.protocol === "https:" ? "wss" : "ws";
const profile = new URLSearchParams(location.search).get("profile") || "lead";
const rfb = new RFB(
  document.querySelector("#screen"),
  `${protocol}://${location.host}/websockify?profile=${encodeURIComponent(profile)}`,
);
rfb.scaleViewport = true;
rfb.resizeSession = true;
