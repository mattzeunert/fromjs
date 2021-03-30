declare const chrome: any;
declare const setTimeout: any;
declare const require: any;
declare const fetch: any;
declare const btoa: any, atob: any;
declare const console: any;
declare const self: any;
declare const localStorage: any;
declare const URL: any;

const thenChrome = require("then-chrome");

var Base64 = {
  // private property
  _keyStr: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",

  // public method for encoding
  encode: function(input) {
    var output = "";
    var chr1, chr2, chr3, enc1, enc2, enc3, enc4;
    var i = 0;

    input = Base64._utf8_encode(input);

    while (i < input.length) {
      chr1 = input.charCodeAt(i++);
      chr2 = input.charCodeAt(i++);
      chr3 = input.charCodeAt(i++);

      enc1 = chr1 >> 2;
      enc2 = ((chr1 & 3) << 4) | (chr2 >> 4);
      enc3 = ((chr2 & 15) << 2) | (chr3 >> 6);
      enc4 = chr3 & 63;

      if (isNaN(chr2)) {
        enc3 = enc4 = 64;
      } else if (isNaN(chr3)) {
        enc4 = 64;
      }

      output =
        output +
        this._keyStr.charAt(enc1) +
        this._keyStr.charAt(enc2) +
        this._keyStr.charAt(enc3) +
        this._keyStr.charAt(enc4);
    } // Whend

    return output;
  }, // End Function encode

  // public method for decoding
  decode: function(input) {
    var output = "";
    var chr1, chr2, chr3;
    var enc1, enc2, enc3, enc4;
    var i = 0;

    input = input.replace(/[^A-Za-z0-9\+\/\=]/g, "");
    while (i < input.length) {
      enc1 = this._keyStr.indexOf(input.charAt(i++));
      enc2 = this._keyStr.indexOf(input.charAt(i++));
      enc3 = this._keyStr.indexOf(input.charAt(i++));
      enc4 = this._keyStr.indexOf(input.charAt(i++));

      chr1 = (enc1 << 2) | (enc2 >> 4);
      chr2 = ((enc2 & 15) << 4) | (enc3 >> 2);
      chr3 = ((enc3 & 3) << 6) | enc4;

      output = output + String.fromCharCode(chr1);

      if (enc3 != 64) {
        output = output + String.fromCharCode(chr2);
      }

      if (enc4 != 64) {
        output = output + String.fromCharCode(chr3);
      }
    } // Whend

    output = Base64._utf8_decode(output);

    return output;
  }, // End Function decode

  // private method for UTF-8 encoding
  _utf8_encode: function(string) {
    var utftext = "";
    string = string.replace(/\r\n/g, "\n");

    for (var n = 0; n < string.length; n++) {
      var c = string.charCodeAt(n);

      if (c < 128) {
        utftext += String.fromCharCode(c);
      } else if (c > 127 && c < 2048) {
        utftext += String.fromCharCode((c >> 6) | 192);
        utftext += String.fromCharCode((c & 63) | 128);
      } else {
        utftext += String.fromCharCode((c >> 12) | 224);
        utftext += String.fromCharCode(((c >> 6) & 63) | 128);
        utftext += String.fromCharCode((c & 63) | 128);
      }
    } // Next n

    return utftext;
  }, // End Function _utf8_encode

  // private method for UTF-8 decoding
  _utf8_decode: function(utftext) {
    var string = "";
    var i = 0;
    var c, c1, c2, c3;
    c = c1 = c2 = 0;

    while (i < utftext.length) {
      c = utftext.charCodeAt(i);

      if (c < 128) {
        string += String.fromCharCode(c);
        i++;
      } else if (c > 191 && c < 224) {
        c2 = utftext.charCodeAt(i + 1);
        string += String.fromCharCode(((c & 31) << 6) | (c2 & 63));
        i += 2;
      } else {
        c2 = utftext.charCodeAt(i + 1);
        c3 = utftext.charCodeAt(i + 2);
        string += String.fromCharCode(
          ((c & 15) << 12) | ((c2 & 63) << 6) | (c3 & 63)
        );
        i += 3;
      }
    } // Whend

    return string;
  } // End Function _utf8_decode
};

async function getBackendPort() {
  function doGetBackendPort() {
    return new Promise(async resolve => {
      chrome.storage.sync.get(["backendPort"], function(result) {
        let bePort = result.backendPort;
        resolve(bePort);
      });
    });
  }

  let bePort = await doGetBackendPort();
  if (!bePort) {
    console.log("BE port not set, will wait 2s and try again");
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  if (!bePort) {
    throw Error("BE port not found");
  }
  bePort = parseFloat(bePort as string);
  return bePort;
}

function setBackendPort(backendPort) {
  return new Promise(resolve => {
    console.log("setBackendPort", backendPort);
    chrome.storage.sync.set({ backendPort }, function() {
      resolve();
    });
  });
}

// const backendPort = 12100;
// const backendPort = 7000;

class TTab {
  target: any;
  tab: any;
  cookiesBefore: any;
  detached = false;
  hasReceivedRequestInterceptedEvent = false;

  constructor() {
    this.onDetach = this.onDetach.bind(this);
    this.onEvent = this.onEvent.bind(this);
  }

  async open(tab, pageUrl = "") {
    this.tab = tab;

    const backendPort = await getBackendPort();

    if (!pageUrl) {
      pageUrl = "http://localhost:" + backendPort + "/start/";
    }

    // navigate away first because we can't enable debugger while on chrome url
    await thenChrome.tabs.update(tab.id, {
      url: "http://localhost:" + backendPort + "/enableDebugger"
    });

    // wait for navigation away from chrome url
    await new Promise(resolve => setTimeout(resolve, 250));

    const targets = await thenChrome.debugger.getTargets();
    const target = targets.find(t => t.type === "page" && t.tabId === tab.id);
    this.target = target;

    // const pageUrl =
    //   "http://localhost:1212/persistent-friendly-authority.glitch.me_2020-03-25_10-04-28.report.html";
    // const pageUrl = "https://capable-ogre.glitch.me/";
    // await thenChrome.tabs.update(tab.id, { url: pageUrl });

    await this._setupDebugger();
    console.log("Done set up debugger");

    await thenChrome.debugger.sendCommand(this._getTargetArg(), "Page.enable");

    await this._setupRequestInterception();

    await thenChrome.tabs.update(tab.id, { url: pageUrl });

    this.log("Will open", pageUrl);
  }

  _getTargetArg() {
    return { targetId: this.target.id };
  }

  log(...args) {
    console.log.apply(console, [
      "[Tab: " + (this.tab && this.tab.id) + "]",
      ...args
    ]);
  }

  onDetach = (source, reason) => {
    this.detached = true;
    if (source.targetId === this.target.id) {
      this.log("Detached", { source, reason });
      chrome.debugger.onDetach.removeListener(this.onDetach);
      chrome.debugger.onEvent.removeListener(this.onEvent);
      // this.onExit();
    }
  };

  onEvent = (target, type, info) => {
    // this.log("On Event", type, info);
    if (target.targetId !== this.target.id) {
      // Not sure why this happens
      return;
    }
    if (type === "Network.requestIntercepted") {
      this._handleInterceptedRequest(info);
      this.hasReceivedRequestInterceptedEvent = true;
    }
    if (
      !this.hasReceivedRequestInterceptedEvent &&
      type === "Network.responseReceived"
    ) {
      // Something is wrong and a non-intercepted response was sent
      // This should not happen, but it does sometimes (in new Chrome profile? older versions?)

      console.log("resposne received", info);

      chrome.debugger.detach(this._getTargetArg());
      chrome.tabs.update(this.tab.id, {
        url: "http://example.com/?interceptFailed"
      });
    }
  };

  async _setupDebugger() {
    return new Promise(async resolve => {
      const targetArg = this._getTargetArg();

      chrome.debugger.onDetach.addListener(this.onDetach);

      await thenChrome.debugger.attach(targetArg, "1.3");

      resolve();
    });
  }

  async _setupRequestInterception() {
    await thenChrome.debugger.sendCommand(
      this._getTargetArg(),
      "Network.enable"
    );
    await thenChrome.debugger.sendCommand(
      this._getTargetArg(),
      "Network.setRequestInterception",
      { patterns: [{ urlPattern: "*", interceptionStage: "Request" }] }
    );

    chrome.debugger.onEvent.addListener(this.onEvent);
  }

  async _handleInterceptedRequest(info) {
    this.log("Request intercepted", info.request.url);
    const interceptionId = info.interceptionId;
    const targetArg = this._getTargetArg();

    const backendPort = await getBackendPort();

    console.log(info.request.url, backendPort);

    const fileExtension = info.request.url
      .split("?")[0]
      .split(".")
      .slice(-1)[0];

    if (
      info.request.url === "about:blank" ||
      info.request.url.startsWith("chrome-extension://") ||
      info.request.url.includes("/storeLogs") ||
      info.request.url.includes("favicon.ico") ||
      // backend alrady knows not to instrument this,
      // but this avoids the extra interception work
      (info.request.url.includes(":" + backendPort) &&
        !info.request.url.includes("/start") &&
        // I don't really get this, but there's an empty.js
        // file that needs to be loaded to do the html mapping in some cases
        !info.request.url.includes("/fromJSInternal")) ||
      ["png", "jpg", "jpeg", "webp"].includes(fileExtension)
    ) {
      console.log("bypassing proxy", info.request.url);
      chrome.debugger.sendCommand(
        targetArg,
        "Network.continueInterceptedRequest",
        {
          interceptionId
        }
      );
      return;
    }

    let rr;
    const reqInfo = {
      url: info.request.url,
      method: info.request.method,
      headers: info.request.headers,
      postData: info.request.postData
    };
    const res = await fetch(
      "http://localhost:" + (await getBackendPort()) + "/makeProxyRequest",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(reqInfo)
      }
    )
      .then(r => {
        rr = r;
        return r.blob();
      })
      .catch(err => {
        console.log("Error making request", reqInfo);
        throw err;
      });

    let headerText = `HTTP/1.1 ${rr.status}
${Array.from(rr.headers)
      .map(([headerKey, headerValue]) => {
        return `${headerKey}: ${headerValue}`;
      })
      .join("\n")}

`;
    console.log(info.request.url, res);

    let headersAndResponseBody = new Blob([headerText, res]);

    var blobToBase64 = function(blob, callback) {
      var reader = new FileReader();
      reader.onload = function() {
        var dataUrl = reader.result;
        var base64 = dataUrl.split(",")[1];
        callback(base64);
      };
      reader.readAsDataURL(blob);
    };

    let rawResponse = await new Promise(resolve => {
      blobToBase64(headersAndResponseBody, resolve);
    });

    chrome.debugger.sendCommand(
      targetArg,
      "Network.continueInterceptedRequest",
      {
        interceptionId,
        rawResponse
      }
    );
  }
}

// setTimeout(() => {
//   chrome.tabs.create({ url: "https://example.com" }, tab => {
//     // const tt = new TTab();
//     // tt.open(tab);
//   });
// }, 100);

let initInterval = setInterval(() => {
  console.log("checking for init page");
  chrome.tabs.query({ title: "fromJSInitPage" }, async tabs => {
    if (tabs.length > 0) {
      console.log("found init page");
      clearInterval(initInterval);
      let url = new URL(tabs[0].url);
      let config = JSON.parse(url.searchParams.get("config"));
      await setBackendPort(config.backendPort);
      console.log("used config", config);
      const tt = new TTab();
      tt.open(tabs[0], config.redirectUrl);
    }
  });
}, 100);

// chrome.browserAction.onClicked.addListener(function (tab) {
//   const tt = new TTab();
//   tt.open(tab);
// });

chrome.tabs.onCreated.addListener(tab => {
  console.log("oncreated", tab);
  const tt = new TTab();
  tt.open(tab);
});
