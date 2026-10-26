/* Surge: 将开屏广告接口改为合法的空 protobuf 响应。 */
(function () {
  "use strict";
  if (typeof $done === "function") {
    $done({ body: new Uint8Array([0x1a, 0x00]) });
  }
})();
