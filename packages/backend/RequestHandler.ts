import * as axios from "axios";
import * as prettyBytes from "pretty-bytes";
import { spawn, Thread, Worker, Pool } from "threads";
import { handleEvalScript } from "@fromjs/core";
import { writeFileSync, fstat, existsSync } from "fs";
import * as path from "path";
import { config } from "@fromjs/core";

let instrumenterFilePath = "instrumentCode.js";
if (!existsSync(path.resolve(__dirname, instrumenterFilePath))) {
  // this happens in jest
  instrumenterFilePath = "dist/instrumentCode.js";
}

function getFileKey(url, body) {
  const hasha = require("hasha");
  const hash = hasha(body, "hex").slice(0, 8);
  return (
    url.replace(/\//g, "_").replace(/[^a-zA-Z\-_\.0-9]/g, "") +
    "_" +
    (url.includes(":5555") ? "eval" : hash)
  );
}

function rewriteHtml(html, { bePort, initialHtmlLogIndex }) {
  const originalHtml = html;
  // Not accurate because there could be an attribute attribute value like ">", should work
  // most of the time
  const openingBodyTag = html.match(/<body.*?>/);
  const openingHeadTag = html.match(/<head.*?>/);
  let bodyStartIndex;
  if (openingBodyTag) {
    bodyStartIndex = html.search(openingBodyTag[0]) + openingBodyTag[0].length;
  }

  let insertionIndex = 0;
  if (openingHeadTag) {
    insertionIndex = html.search(openingHeadTag[0]) + openingHeadTag[0].length;
  } else if (openingBodyTag) {
    insertionIndex = bodyStartIndex;
  }

  const insertions: any[] = [];
  if (openingBodyTag) {
    const hasScriptTagInBody = html.slice(bodyStartIndex).includes("<script");
    if (!hasScriptTagInBody) {
      // insert script tag just so that HTML origin mapping is done
      const closingBodyTagIndex = html.search(/<\/body/);
      if (closingBodyTagIndex !== -1) {
        insertions.push({
          index: closingBodyTagIndex,
          text: `<script data-fromjs-remove-before-initial-html-mapping src="http://localhost:${bePort}/fromJSInternal/empty.js"></script>`
        });
      }
    }
  }
  // Note: we don't want to have any empty text between the text, since that won't be removed
  // alongside the data-fromjs-remove-before-initial-html-mapping tags!
  var insertedHtml =
    `<script data-fromjs-dont-instrument data-fromjs-remove-before-initial-html-mapping>window.__fromJSInitialPageHtmlLogIndex = ${initialHtmlLogIndex};window.__fromJSInitialPageHtml = decodeURI("${encodeURI(
      originalHtml
    )}")</script>` +
    `<script src="http://localhost:${bePort}/jsFiles/babel-standalone.js" data-fromjs-remove-before-initial-html-mapping></script>` +
    `<script src="http://localhost:${bePort}/jsFiles/compileInBrowser.js" data-fromjs-remove-before-initial-html-mapping></script>`;

  insertions.push({
    index: insertionIndex,
    text: insertedHtml
  });

  return {
    insertions
  };
}

export class RequestHandler {
  _shouldBlock: any;
  _accessToken: string;
  _backendPort: number;
  _storeLocs: any;
  _shouldInstrument: any;
  _sessionDirectory: string;
  _onCodeProcessed: any;
  _files: any;
  _pool: any;
  _backendOriginWithoutPort: string;

  constructor({
    shouldBlock,
    accessToken,
    backendPort,
    storeLocs,
    shouldInstrument,
    onCodeProcessed,
    sessionDirectory,
    files,
    backendOriginWithoutPort
  }) {
    this._shouldBlock = shouldBlock;
    this._accessToken = accessToken;
    this._backendPort = backendPort;
    this._storeLocs = storeLocs;
    this._shouldInstrument = shouldInstrument;
    // this._cache = {};
    this._sessionDirectory = sessionDirectory;
    this._onCodeProcessed = onCodeProcessed;
    this._backendOriginWithoutPort = backendOriginWithoutPort;

    this._files = files;
    this._pool = Pool(() => spawn(new Worker(instrumenterFilePath)), 4);
    // files.forEach(f => {
    //   ["", "?dontprocess", ".map"].forEach(postfix => {
    //     let path = this._sessionDirectory + "/files/" + f.fileKey + postfix;
    //     if (existsSync(path)) {
    //       this._cache[f.url + postfix] = readFileSync(path, "utf-8");
    //     }
    //   });
    // });
  }

  _cache = {};

  _afterCodeProcessed({ url, fileKey, raw, instrumented, map, details }) {
    writeFileSync(this._sessionDirectory + "/files/" + fileKey, instrumented);
    writeFileSync(
      this._sessionDirectory + "/files/" + fileKey + "?dontprocess",
      raw
    );
    writeFileSync(
      this._sessionDirectory + "/files/" + fileKey + ".map",
      JSON.stringify(map, null, 2)
    );

    // ["", "?dontprocess", ".map"].forEach(postfix => {
    //   let path = this._sessionDirectory + "/files/" + fileKey + postfix;
    //   if (existsSync(path)) {
    //     this._cache[url + postfix] = readFileSync(path, "utf-8");
    //   }
    // });

    this._onCodeProcessed({ url, fileKey, details });
  }

  async handleRequest({ url, method, headers, postData }) {
    if (this._shouldBlock({ url })) {
      return {
        status: 401,
        headers: {},
        body: Buffer.from(""),
        fileKey: "blocked"
      };
    }

    let timeLogKey = "handleRequest_" + url;
    config.LOG_PERF && console.time(timeLogKey);
    function logTimeEnd() {
      config.LOG_PERF && console.timeEnd(timeLogKey);
    }

    let isDontProcess = url.includes("?dontprocess");
    let isMap = url.includes(".map");
    url = url.replace("?dontprocess", "").replace(".map", "");

    let file = this._files.find(f => f.url == url)!;
    if (file) {
      let postfix = "";
      if (isDontProcess) {
        postfix = "?dontprocess";
      }
      if (isMap) {
        postfix = ".map";
      }
      let path = this._sessionDirectory + "/files/" + file.fileKey + postfix;

      const ret = {
        body: require("fs").readFileSync(path, "utf-8"),
        headers: {},
        status: 200
      };
      logTimeEnd();
      return ret;
    }

    let isJS = url.split("?")[0].endsWith(".js");
    var isHtml =
      !isJS &&
      !url.endsWith(".png") &&
      !url.endsWith(".jpg") &&
      !url.endsWith(".woff2") &&
      headers.Accept &&
      headers.Accept.includes("text/html");

    //@ts-ignore
    let { status, data, headers: responseHeaders } = await axios({
      url,
      method: method,
      headers: {
        ...headers,
        "accept-encoding": "gzip, deflate",
        "accept-language": "en-US,en;q=0.9,mt;q=0.8",
        ...(isHtml
          ? {
              "sec-fetch-dest": "document",
              "sec-fetch-mode": "navigate",
              "sec-fetch-site": "none"
            }
          : {})
      },
      validateStatus: status => true,
      // prevent e.g parse json
      transformResponse: data => data,
      data: postData
    });

    const hasha = require("hasha");
    const hash = hasha(data, "hex").slice(0, 8);

    if (this._shouldInstrument({ url })) {
      if (isJS) {
        const { code, map, locs } = await this._requestProcessCode(
          data.toString(),
          url
        );

        data = code;
        // console.log("Code len", code.length);
        // console.log("updated data", code.slice(0, 100));
      } else if (isHtml) {
        // console.log("ishtml");
        let initialHtmlLogIndex =
          990000000000000 + Math.round(Math.random() * 10000000000);

        let rawHtml = data.toString();

        const { insertions } = rewriteHtml(rawHtml, {
          bePort: this._backendPort,
          initialHtmlLogIndex
        });

        data = await this._compileHtmlInlineScriptTags(
          data,
          initialHtmlLogIndex,
          insertions
        );

        this._afterCodeProcessed({
          url,
          fileKey: getFileKey(url, rawHtml),
          raw: rawHtml,
          instrumented: data,
          details: {},
          map: null
        });

        // Remove integrity hashes, since the browser will prevent loading
        // the instrumented HTML otherwise
        data = data.replace(/ integrity="[\S]+"/g, "");
      }
    }

    // console.log(data);

    responseHeaders["content-length"] = data.length;
    logTimeEnd();
    return {
      status,
      body: Buffer.from(data),
      headers: responseHeaders
    };
  }

  async _requestProcessCode(body, url, details = {}) {
    let fileKey = getFileKey(url, body);

    const babelPluginOptions = {
      accessToken: this._accessToken,
      backendPort: this._backendPort,
      backendOriginWithoutPort: this._backendOriginWithoutPort
    };
    // console.log({ babelPluginOptions });

    const RUN_IN_SAME_PROCESS = false;

    let r;
    if (RUN_IN_SAME_PROCESS) {
      console.log("Running compilation in proxy process for debugging");
      var compile = require("./" + instrumenterFilePath);
      r = await compile({ body, url, babelPluginOptions });
    } else {
      await this._pool.queue(async compilerProcess => {
        const inProgressTimeout = setTimeout(() => {
          console.log(
            "Instrumenting: " + url + " (" + prettyBytes(body.length) + ")"
          );
        }, 5000);
        const response = await compilerProcess.instrument({
          body,
          url,
          babelPluginOptions
        });
        clearTimeout(inProgressTimeout);
        if (response.error) {
          console.log("got response with error");
          throw response.error;
        }
        // console.log("timeTakenMs", response.timeTakenMs);
        if (response.timeTakenMs > 2000) {
          const sizeBeforeString = prettyBytes(response.sizeBefore);
          const sizeAfterString = prettyBytes(response.sizeAfter);
          console.log(
            `Instrumented ${url} took ${
              response.timeTakenMs
            }ms, ${sizeBeforeString} => ${sizeAfterString}`
          );
        }
        r = response;
        r.details = details;
        return r;
      });

      // .on("message", function(response) {
      //   console.log({ response });
      //   resolve(response);
      //   compilerProcess.kill();
      //   clearTimeout(inProgressTimeout);
      // })
      // .on("error", error => {
      //   console.log("worker error", error);
      //   clearTimeout(inProgressTimeout);
      // });
    }
    this._storeLocs(r.locs);

    this._afterCodeProcessed({
      url,
      fileKey,
      raw: body,
      instrumented: r.code,
      map: r.map,
      details: r.details
    });
    //   this.cacheUrl(url, {
    //           headers: {},
    //           body: instrumentedCode
    //         });

    //         this.cacheUrl(url + "?dontprocess", {
    //           headers: {},
    //           body: code
    //         });

    //         this.cacheUrl(url + ".map", {
    //           headers: {},
    //           body: map
    //         });

    return r;
  }

  async _compileHtmlInlineScriptTags(body, initialHtmlLogIndex, insertions) {
    // disable content security policy so worker blob can be loaded
    body = body.replace(/http-equiv="Content-Security-Policy"/g, "");

    var MagicString = require("magic-string");
    var magicHtml = new MagicString(body);
    const parse5 = require("parse5");
    const doc = parse5.parse(body, { sourceCodeLocationInfo: true });

    const walk = require("walk-parse5");

    const inlineScriptTags: any[] = [];

    walk(doc, async node => {
      // Optionally kill traversal
      if (node.tagName === "script") {
        if (
          node.attrs.find(attr => attr.name === "data-fromjs-dont-instrument")
        ) {
          return;
        }
        const hasSrcAttribute = !!node.attrs.find(attr => attr.name === "src");
        const typeAttribute = node.attrs.find(attr => attr.name === "type");

        const typeIsJS =
          !typeAttribute ||
          ["application/javascript", "text/javascript"].includes(
            typeAttribute.value
          );
        const isInlineScriptTag = !hasSrcAttribute && typeIsJS;
        if (isInlineScriptTag) {
          inlineScriptTags.push(node);
        }
      }
    });

    await Promise.all(
      inlineScriptTags.map(async node => {
        const code = node.childNodes[0].value;
        const compRes = <any>await this.instrumentForEval(code, {
          type: "scriptTag",
          sourceOperationLog: initialHtmlLogIndex,
          sourceOffset: node.childNodes[0].sourceCodeLocation.startOffset
        });
        node.compiledCode = compRes.instrumentedCode;
      })
    );

    // console.log("has compiled");

    inlineScriptTags.forEach(node => {
      const textLoc = node.childNodes[0].sourceCodeLocation;
      magicHtml.overwrite(
        textLoc.startOffset,
        textLoc.endOffset,
        node.compiledCode
      );
    });

    for (const insertion of insertions) {
      magicHtml.appendLeft(insertion.index, insertion.text);
    }

    return magicHtml.toString();
  }

  async processCode(body, url, details = {}) {
    // var cacheKey = body + url;
    // if (this.processCodeCache[cacheKey]) {
    //   return Promise.resolve(this.processCodeCache[cacheKey]);
    // }
    let response = await this._requestProcessCode(body, url, details);
    var { code, map, locs, timeTakenMs, sizeBefore, sizeAfter } = <any>response;
    // console.log("req process code done", url);

    if (timeTakenMs > 2000) {
      const sizeBeforeString = prettyBytes(sizeBefore);
      const sizeAfterString = prettyBytes(sizeAfter);
      console.log(
        `Instrumented ${url} took ${timeTakenMs}ms, ${sizeBeforeString} => ${sizeAfterString}`
      );
    }

    var result = { code, map };
    //   this.setProcessCodeCache(body, url, result);
    return result;
  }

  instrumentForEval(code, details) {
    return new Promise(async (resolve, reject) => {
      const compile = (code, url, done, details) => {
        this.processCode(code, url, details)
          .then(done)
          .catch(reject);
      };
      handleEvalScript(
        code,
        compile,
        details,
        ({ url, instrumentedCode, code, map }) => {
          resolve({
            instrumentedCode
          });
        },
        err => {
          reject(err);
        }
      );
    });
  }
}
