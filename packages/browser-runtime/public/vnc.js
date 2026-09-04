import RFB from "/novnc/core/rfb.js";

const protocol = location.protocol === "https:" ? "wss" : "ws";
const rfb = new RFB(
  document.querySelector("#screen"),
  `${protocol}://${location.host}/websockify`,
);
rfb.scaleViewport = true;
rfb.resizeSession = true;
