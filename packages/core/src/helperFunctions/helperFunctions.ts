import OperationLog, { getOperationIndex } from "./OperationLog";
import getElementOperationLogMapping from "./getHtmlNodeOperationLogMapping";
import getHtmlNodeOperationLogMapping from "./getHtmlNodeOperationLogMapping";
import initDomInspectionUI from "./initDomInspectionUI";
import KnownValues from "./KnownValues";
import { ExecContext } from "./ExecContext";
import operations from "../operations";
import { SKIP_TRACKING, VERIFY, KEEP_LOGS_IN_MEMORY } from "../config";
import * as FunctionNames from "../FunctionNames";
import { initLogging, consoleCount, consoleLog, consoleError } from "./logging";
import { getStoreLogsWorker } from "./storeLogsWorker";
import * as OperationTypes from "../OperationTypes";
import { mapPageHtml } from "../mapPageHtml";
import mapInnerHTMLAssignment from "../operations/domHelpers/mapInnerHTMLAssignment";
import { CreateOperationLogArgs, ValueTrackingValuePair } from "../types";
import { traverseObject } from "../traverseObject";
import * as objectPath from "object-path";
import { getShortOperationName } from "../names";

const accessToken = "ACCESS_TOKEN_PLACEHOLDER";

var global = Function("return this")();
global.__didInitializeDataFlowTracking = true;

global.getElementOperationLogMapping = getElementOperationLogMapping;

let knownValues = new KnownValues();
// Make sure to use native methods in case browser methods get
// overwritten (e.g. NewRelic instrumentation does it)
// (only matters if we're not in the web worker)
let fetch = knownValues.getValue("fetch");

initLogging(knownValues);

const startTime = new Date();
setTimeout(checkDone, 20);
function checkDone() {
  if (typeof document === "undefined") {
    return;
  }
  const done =
    document.querySelector(".todo-list li") ||
    document.querySelector(".list-card-title");
  if (done) {
    const doneTime = new Date();
    consoleLog("#####################################");
    consoleLog("#####################################");
    consoleLog("#####################################");
    consoleLog("#####################################");
    consoleLog("#####################################");
    consoleLog("#####################################");
    consoleLog(
      "DONE",
      "timeTaken: " + (doneTime.valueOf() - startTime.valueOf()) / 1000 + "s"
    );
    worker.postMessage({ showDoneMessage: true });
  } else {
    setTimeout(checkDone, 20);
  }
}

function nodeHttpReq({ port, path, headers, bodyString, method }) {
  return new Promise(resolve => {
    /* eval, otherwise webpack will replace it*/
    const https = eval(`require("http")`);

    const options = {
      hostname: "localhost",
      port: port,
      path: path,
      method,
      headers: {
        ...headers,
        "Content-Type": "application/json"
      }
    };

    const req = https.request(options, res => {
      console.log(`statusCode: ${res.statusCode}`);

      let resStr = "";
      res.on("data", d => {
        console.log(d.toString());
        resStr += d.toString();
      });
      res.on("end", d => {
        console.log("req end");
        resolve(resStr);
      });
    });

    req.on("error", error => {
      console.error(error);
    });

    if (bodyString) {
      req.write(bodyString);
    }
    req.end();
  });
}

let backendPort = "BACKEND_PORT_PLACEHOLDER";
let backendOriginWithoutPort = "BACKEND_ORIGIN_WITHOUT_PORT_PLACEHOLDER";

let requestQueueDirectory;

if (global.fromJSIsNode) {
  const cmd = `node -e "eval(decodeURIComponent(\\"${encodeURIComponent(
    nodeHttpReq.toString() +
      `;nodeHttpReq({port: ${backendPort}, path: '/sessionInfo', headers: {}, method: 'GET'}).then(r => console.log('RES_'+r+'_RES'));`
  )}\\"))"`;
  const r = eval("require('child_process')").execSync(cmd);
  const sessionInfo = JSON.parse(r.toString().match(/RES_(.*)_RES/)[1]);
  console.log({ sessionInfo });
  requestQueueDirectory = sessionInfo.requestQueueDirectory;
}

let fs;
let fsProperties;
if (global.fromJSIsNode) {
  fs = eval("require('fs')");
  fsProperties = { ...fs };
}

function setFsProperties(fsProperties) {
  Object.keys(fsProperties).forEach(propertyName => {
    let value = fsProperties[propertyName];
    if (typeof value === "function") {
      fs[propertyName] = fsProperties[propertyName];
    }
  });
}

function nodePost({ port, path, headers, bodyString }) {
  if (requestQueueDirectory) {
    // graceful-fs patches some methods and adding tracking data
    // as part of saving stuff breaks the normal flow...
    // (e.g. because lastmemberexpressionobject is not right any more)
    let fsPropertiesBefore = { ...fs };
    setFsProperties(fsProperties);

    let opCount = ctx.countOperations(() => {
      fs.writeFileSync(
        requestQueueDirectory +
          "/" +
          new Date().valueOf() +
          "_" +
          Math.round(Math.random() * 1000) +
          ".json",
        path + "\n" + bodyString
      );
    });

    if (opCount > 0) {
      console.log(
        `Did ${opCount} operations during writeFileSync, maybe something is patched?`
      );
    }

    setFsProperties(fsPropertiesBefore);

    return Promise.resolve({});
  }

  return nodeHttpReq({ port, path, headers, bodyString, method: "POST" });
}

function makePostToBE({ accessToken, fetch }) {
  return function postToBE(endpoint, data, statsCallback = function(stats) {}) {
    const stringifyStart = new Date();
    let body = data;
    let bodyIsString = typeof body === "string";
    if (!bodyIsString) {
      console.time("stringify");
      data.pageSessionId = global["fromJSPageSessionId"];
      body = safeJsonStringify(data);
      console.timeEnd("stringify");
    }

    console.log("body len in mb", body.length / 1024 / 1024);
    const stringifyEnd = new Date();
    if (endpoint === "/storeLogs") {
      statsCallback({
        bodyLength: body.length,
        stringifyTime: stringifyEnd.valueOf() - stringifyStart.valueOf()
      });
    }

    const headers = {
      Accept: "application/json",
      Authorization: accessToken
    };
    if (!bodyIsString) {
      headers["Content-Type"] = "application/json";
    }
    let p;
    if (global.fromJSIsNode) {
      p = nodePost({
        port: backendPort,
        path: endpoint,
        bodyString: body,
        headers
      });
    } else {
      const url = backendOriginWithoutPort + ":" + backendPort + endpoint;
      p = fetch(url, {
        method: "POST",
        headers: global.fromJSIsNode ? headers : new Headers(headers),
        body: body
      });
    }

    return p;
  };
}

const postToBE = makePostToBE({ accessToken, fetch });

let logQueue = [];
global["__debugFromJSLogQueue"] = () => logQueue;
let evalScriptQueue = [];
let eventQueue = [];
let luckyMatchQueue = [];
let worker: Worker | null = null;
// temporarily disable worker because i think lighthouse runs stuff in isolated envs
// and it means hundreds of workers get created rather than always using same one?
// try {
//   getStoreLogsWorker({
//   makePostToBE,
//   accessToken
// });
// }catch(err){
//   console.log("Create worker error, should be ok though", err.message)
// }

let inProgressSendLogsRequests = 0;
async function sendLogsToServer() {
  if (logQueue.length === 0 && evalScriptQueue.length == 0) {
    return;
  }

  // const data = {
  //   logs: logQueue,
  //   evalScripts: evalScriptQueue,
  //   events: eventQueue
  // };

  let data = "";

  data += safeJsonStringify(evalScriptQueue);
  data += "\n";
  data += safeJsonStringify(eventQueue);
  data += "\n";
  data += safeJsonStringify(luckyMatchQueue);
  data += "\n";
  for (const item of logQueue) {
    data += item[0] + "\n" + item[1] + "\n";
  }

  logQueue = [];
  evalScriptQueue = [];
  eventQueue = [];
  luckyMatchQueue = [];

  if (worker) {
    // Doing this means the data will be cloned, but it seems to be
    // reasonably fast anyway
    // Creating the json and making the request in the main thread is super slow!
    console.time("postMessage");
    worker.postMessage(data);
    console.timeEnd("postMessage");
  } else {
    // consoleLog(
    //   "Can't create worker (maybe already inside a web worker?), will send request in normal thread"
    // );
    inProgressSendLogsRequests++;
    if (inProgressSendLogsRequests > 2) {
      console.log({ inProgressSendLogsRequests });
    }
    await postToBE("/storeLogs", data);
    inProgressSendLogsRequests--;
  }
}
// If page laods quickly try to send data to BE soon, later on wait
// 1s between requests
setTimeout(sendLogsToServer, 200);
setTimeout(sendLogsToServer, 400);
setInterval(sendLogsToServer, 1000);
function remotelyStoreLog(logIndex, logString) {
  logQueue.push([logIndex, logString]);
}

var safeJsonStringify = JSON.stringify.bind(JSON);
var safeJsonParse = JSON.parse.bind(JSON);

global["__fromJSWaitForSendLogsAndExitNodeProcess"] = async function() {
  console.log("__fromJSWaitForSendLogsAndExitNodeProcess");
  sendLogsToServer();
  while (inProgressSendLogsRequests > 0) {
    console.log({ inProgressSendLogsRequests });
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  eval("process.exit()");
};

declare var __storeLog;

const storeLog =
  typeof __storeLog !== "undefined" ? __storeLog : remotelyStoreLog;

let skipTracking = SKIP_TRACKING;

let lastOperationType = null;
function createOperationLog(args: CreateOperationLogArgs, op, index) {
  if (skipTracking) {
    return null;
  }
  var log = OperationLog.createAtRuntime(args, knownValues, op);
  storeLog(index, safeJsonStringify(log));

  if (KEEP_LOGS_IN_MEMORY) {
    // Normally we just store the numbers, but it's useful for
    // debugging to be able to view the log object
    global["__debugAllLogs"] = global["__debugAllLogs"] || {};
    global["__debugAllLogs"][log.index] = log;
  }
}

// Used to speed up slow parts of a program, e.g. for the Lighthouse
// JSON parser or other buffer processing logic
// ----
// Counter used to handle nested function calls that disable at start and end
let skipTrackingCounter = 0;
global["__FromJSDisableCollectTrackingData"] = function(label) {
  skipTrackingCounter++;
  console.log("Disable FromJS tracking", { skipTrackingCounter, label });
  skipTracking = true;
};
global["__FromJSEnableCollectTrackingData"] = function(label) {
  skipTrackingCounter--;
  console.log("Enable FromJS tracking", { skipTrackingCounter, label });
  if (skipTrackingCounter === 0) {
    skipTracking = SKIP_TRACKING;
  }
};

if (KEEP_LOGS_IN_MEMORY) {
  global["__debugLookupLog"] = function(logId, currentDepth = 0) {
    try {
      var log = safeJsonParse(
        safeJsonStringify(global["__debugAllLogs"][logId])
      );
      if (currentDepth < 12) {
        const newArgs = {};
        Object.keys(log.args).forEach(key => {
          newArgs[key] = global["__debugLookupLog"](
            log.args[key],
            currentDepth + 1
          );
        });
        log.args = newArgs;
      }
      if (currentDepth < 12 && log.extraArgs) {
        const newExtraArgs = {};
        Object.keys(log.extraArgs).forEach(key => {
          newExtraArgs[key] = global["__debugLookupLog"](
            log.extraArgs[key],
            currentDepth + 1
          );
        });
        log.extraArgs = newExtraArgs;
      }

      return log;
    } catch (err) {
      return logId;
    }
  };
}

global[FunctionNames.getGlobal] = function() {
  return global;
};

var argTrackingInfo = null;
var functionContextTrackingValue = null;

global["__fromJSGetTrackingIndex"] = function(value) {
  return global[FunctionNames.getFunctionArgTrackingInfo](0);
};

global[FunctionNames.getFunctionArgTrackingInfo] = function getArgTrackingInfo(
  index
) {
  if (!argTrackingInfo) {
    // this can happen when function is invoked without callexpression op,
    // e.g. when it's a callback argument to a native api call
    // TODO: return some kind of tracking value here ("untracked argument")
    // ideally also include a loc
    if (VERIFY) {
      consoleLog("no arg tracking info...");
    }
    return undefined;
  }
  if (index === undefined) {
    return argTrackingInfo;
  }
  return argTrackingInfo[index];
};
global[FunctionNames.getFunctionContextTrackingValue] = function() {
  return functionContextTrackingValue;
};

global.getTrackingAndNormalValue = function(value) {
  return {
    normal: value,
    tracking: argTrackingInfo[0]
  };
};

// don't think this is needed, only used in demo with live code ediotr i think
global.inspect = function(value) {
  global.inspectedValue = {
    normal: value,
    tracking: argTrackingInfo[0]
  };
};

initDomInspectionUI(backendPort, backendOriginWithoutPort);

global["__getHtmlNodeOperationLogMapping"] = getHtmlNodeOperationLogMapping;

global["fromJSPageSessionId"] = (
  Math.random().toString() +
  "_" +
  Math.random().toString()
).replace(/\./g, "");
global.fromJSInspect = function(value: any, charIndex: number) {
  let logId;
  if (!argTrackingInfo && typeof value === "number") {
    if (charIndex) {
      throw Error("Not supported yet");
    }
    logId = value;
  } else if (value instanceof Node) {
    const mapping = getHtmlNodeOperationLogMapping(value);
    consoleLog({ mapping });
    postToBE("/inspectDOM", { ...mapping, charIndex });
  } else {
    if (charIndex) {
      throw Error("Not supported yet");
    }
    logId = argTrackingInfo[0];
  }
  if (window["onFromJSInspect"]) {
    window["onFromJSInspect"]();
  }

  return postToBE("/inspect", {
    logId
  });
};

function getTrackingPropName(propName) {
  if (VERIFY) {
    try {
      if (parseFloat(propName) > 200) {
        consoleLog(
          "tracking array index greater than 200...1) perf issue, 2) possibly some kind of infinite loop"
        );
      }
    } catch (err) {}
  }
  // note: might be worth using Map instead and seeing how perf is affected
  if (typeof propName === "symbol") {
    return propName;
  } else {
    // "_" prefix because to avoid conflict with normal object methods,
    // e.g. there used to be problems when getting tracking value for "constructor" prop
    return "_" + propName;
  }
}

function trackPromiseResolutionValue(promise, trackingValue) {
  // todo: map<promise, trackingvalue> might be better
  // if the program for some reason inspects the promise properties?
  if (!promise) {
    console.log("No promise passed into trackPromiseResolutionValue!");
    return;
  }
  promise["_resTrackingValue"] = trackingValue;
}
function getPromiseResolutionTrackingValue(promise) {
  if (!promise) {
    console.log("No promise passed into getPromiseResolutionTrackingValue!");
    return;
  }
  return promise["_resTrackingValue"];
}

const objTrackingMap = new WeakMap();
global["__debugObjTrackingMap"] = objTrackingMap;
function trackObjectPropertyAssignment(
  obj,
  propName,
  propertyValueTrackingValue,
  propertyNameTrackingValue = null
) {
  if (!propertyNameTrackingValue && VERIFY) {
    consoleCount("no propertyNameTrackingValue");
  }
  var objectPropertyTrackingInfo = objTrackingMap.get(obj);
  if (!objectPropertyTrackingInfo) {
    objectPropertyTrackingInfo = {};
    objTrackingMap.set(obj, objectPropertyTrackingInfo);
  }
  if (
    typeof propertyValueTrackingValue !== "number" &&
    !!propertyValueTrackingValue
  ) {
    console.log("Tracking value is not a number:", propertyValueTrackingValue);
    debugger;
  }
  objectPropertyTrackingInfo[getTrackingPropName(propName)] = {
    value: propertyValueTrackingValue,
    name: propertyNameTrackingValue
  };
}

function getObjectPropertyTrackingValues(obj, propName) {
  var objectPropertyTrackingInfo = objTrackingMap.get(obj);
  if (!objectPropertyTrackingInfo) {
    return undefined;
  }
  const trackingValues =
    objectPropertyTrackingInfo[getTrackingPropName(propName)];
  if (!trackingValues) {
    return undefined;
  }
  return trackingValues;
}

function getObjectPropertyValueTrackingValue(obj, propName) {
  const trackingValues = getObjectPropertyTrackingValues(obj, propName);
  if (trackingValues === undefined) {
    return undefined;
  }
  return trackingValues.value;
}
global["getObjectPropertyTrackingValue"] = getObjectPropertyValueTrackingValue;

function getObjectPropertyNameTrackingValue(obj, propName) {
  const trackingValues = getObjectPropertyTrackingValues(obj, propName);
  if (trackingValues === undefined) {
    return undefined;
  }
  return trackingValues.name;
}

global[
  FunctionNames.getObjectPropertyNameTrackingValue
] = getObjectPropertyNameTrackingValue;

var lastMemberExpressionObjectValue = null;
var lastMemberExpressionObjectTrackingValue = null;
global[FunctionNames.getLastMemberExpressionObject] = function() {
  return [
    lastMemberExpressionObjectValue,
    lastMemberExpressionObjectTrackingValue
  ];
};

global[FunctionNames.getEmptyTrackingInfo] = function(
  type,
  loc,
  result = undefined
) {
  let index = getOperationIndex();
  let logData: any = {
    operation: "emptyTrackingInfo",
    result,
    args: {},
    runtimeArgs: { type },
    astArgs: {},
    loc
  };

  createOperationLog(logData, operations["emptyTrackingInfo"], index);
  return index;
};

global[FunctionNames.expandArrayForArrayPattern] = function(
  arr,
  loc,
  type,
  namedParamCount
) {
  if (!Array.isArray(arr)) {
    // e.g. Maps or arguments objects
    arr = Array.from(arr);
  }

  if (type === "forOf") {
    return arr.map(val => {
      return global[FunctionNames.expandArrayForArrayPattern](
        val,
        loc,
        "forOf_element",
        namedParamCount
      );
    });
  }
  const resultArr = [];
  const restResult = [];
  arr.forEach((value, i) => {
    const trackingValue = ctx.getObjectPropertyTrackingValue(arr, i);
    const newTrackingValue = ctx.createOperationLog({
      operation: ctx.operationTypes.arrayPattern,
      args: {
        value: [value, trackingValue]
      },
      astArgs: {},
      result: value,
      loc: loc
    });
    if (i < namedParamCount) {
      resultArr.push(value);
      resultArr.push(newTrackingValue);
    } else {
      restResult.push(value);
      ctx.trackObjectPropertyAssignment(
        restResult,
        i - namedParamCount,
        newTrackingValue
      );
    }
  });

  while (namedParamCount > resultArr.length / 2) {
    resultArr.push(undefined);
  }

  resultArr.push(
    global[FunctionNames.getEmptyTrackingInfo](
      "arrayPatternExpansion_rest",
      loc
    )
  );

  resultArr.push(restResult);
  return resultArr;
};
global[FunctionNames.expandArrayForSpreadElement] = function(arr) {
  if (!Array.isArray(arr)) {
    // Map or arguments object
    arr = Array.from(arr);
  }
  return arr.map((elem, i) => {
    return [elem, ctx.getObjectPropertyTrackingValue(arr, i)];
  });
};

const MAX_TRACKED_ARRAY_INDEX = 10;

var lastReturnStatementResult = null;

const memoValues = {};
global[FunctionNames.setMemoValue] = function(key, value, trackingValue) {
  memoValues[key] = { value, trackingValue };
  setLastOpTrackingResult(trackingValue);
  if (VERIFY) {
    validateTrackingValue(trackingValue);
  }
  return value;
};
global[FunctionNames.getMemoArray] = function(key) {
  const memo = memoValues[key];
  return [memo.value, memo.trackingValue];
};
global[FunctionNames.getMemoValue] = function(key) {
  return memoValues[key].value;
};
global[FunctionNames.getMemoTrackingValue] = function(key) {
  return memoValues[key].trackingValue;
};

function validateTrackingValue(trackingValue) {
  if (!!trackingValue && typeof trackingValue !== "number") {
    debugger;
    throw Error("eee");
  }
}

function setLastOpTrackingResult(trackingValue) {
  if (VERIFY) {
    validateTrackingValue(trackingValue);
  }

  lastOpTrackingResult = trackingValue;
}

const ctx: ExecContext = {
  operationTypes: OperationTypes,
  getObjectPropertyTrackingValue: getObjectPropertyValueTrackingValue,
  getObjectPropertyNameTrackingValue,
  trackObjectPropertyAssignment,
  trackPromiseResolutionValue,
  getPromiseResolutionTrackingValue,
  hasInstrumentationFunction: typeof global["__fromJSEval"] === "function",
  createOperationLog: function(args) {
    let index = getOperationIndex();
    const op = operations[args.operation];
    args.operation = getShortOperationName(args.operation);
    createOperationLog(args, op, index);
    return index;
  },
  createArrayIndexOperationLog(index, loc) {
    if (index > MAX_TRACKED_ARRAY_INDEX) {
      // Just too much cost tracking this, and not much value
      return null;
    }
    return ctx.createOperationLog({
      operation: ctx.operationTypes.arrayIndex,
      result: index,
      loc: loc
    });
  },
  knownValues,
  global,
  registerEvalScript(evalScript) {
    // store code etc for eval'd code
    evalScriptQueue.push(evalScript);
  },
  registerEvent(event) {
    // events like file writes
    eventQueue.push(event);
  },
  objectHasPropertyTrackingData(obj) {
    return !!objTrackingMap.get(obj);
  },
  getEmptyTrackingInfo(type, loc, result = undefined) {
    return global[FunctionNames.getEmptyTrackingInfo](type, loc, result);
  },
  getCurrentTemplateLiteralTrackingValues() {
    return getCurrentTemplateLiteralTrackingValues();
  },
  get lastOpTrackingResult() {
    return lastOpTrackingResult;
  },
  get lastOpTrackingResultWithoutResetting() {
    return lastOpTrackingResultWithoutResetting;
  },
  get lastReturnStatementResult() {
    return lastReturnStatementResult;
  },
  set lastReturnStatementResult(val) {
    lastReturnStatementResult = val;
  },
  set lastMemberExpressionResult([normal, tracking]) {
    lastMemberExpressionObjectValue = normal;
    lastMemberExpressionObjectTrackingValue = tracking;
  },
  set argTrackingInfo(info) {
    if (VERIFY && info) {
      info.forEach(trackingValue => validateTrackingValue(trackingValue));
    }
    argTrackingInfo = info;
  },
  set functionContextTrackingValue(tv: number) {
    functionContextTrackingValue = tv;
  },
  get lastOperationType() {
    return lastOperationType;
  },
  countOperations(fn) {
    let before = opExecCount;
    fn();
    return opExecCount - before;
  }
};

var lastOpValueResult = null;
var lastOpTrackingResult = null;
let lastOpTrackingResultWithoutResetting = null;

let opExecCount = 0;

function makeDoOperation(opName: string, op) {
  const opExec = op.exec;
  const shortName = getShortOperationName(opName);
  return function ___op(objArgs, astArgs, loc) {
    let index = getOperationIndex();
    let logData: any = {
      operation: shortName,
      args: objArgs,
      astArgs: astArgs,
      loc,
      index
    };

    var ret = opExec(objArgs, astArgs, ctx, logData);
    opExecCount++;

    logData.result = ret;
    createOperationLog(logData, op, index);

    lastOpValueResult = ret;

    lastOpTrackingResultWithoutResetting = index;
    setLastOpTrackingResult(index);

    lastOperationType = opName;

    if (logQueue.length > 200000) {
      // avoid running out of memory
      sendLogsToServer();
    }

    return ret;
  };
}

global[FunctionNames.doOperation] = function ___op(
  opName: string,
  objArgs,
  astArgs,
  loc
) {
  return global["__" + opName](objArgs, astArgs, loc);
};

Object.keys(operations).forEach(opName => {
  const op = operations[opName];
  const doOpFunction = makeDoOperation(opName, op);

  // The object creation in so many places is expensive
  // so some simple ops have a shorthand function that
  // is called instead of __op and calls through to __op
  if (op.shorthand) {
    global[op.shorthand.fnName] = op.shorthand.getExec(doOpFunction);
  }

  global["__" + opName] = doOpFunction;
});

global[FunctionNames.getLastOperationValueResult] = function getLastOp() {
  var ret = lastOpValueResult;
  lastOpValueResult = null;
  return ret;
};
global[FunctionNames.getLastOperationTrackingResult] = function getLastOp() {
  if (VERIFY) {
    validateTrackingValue(lastOpTrackingResult);
  }
  var ret = lastOpTrackingResult;
  lastOpTrackingResult = null;
  return ret;
};
global[
  FunctionNames.getLastOperationTrackingResultWithoutResetting
] = function getLastOp() {
  if (VERIFY) {
    validateTrackingValue(lastOpTrackingResult);
  }
  return lastOpTrackingResult;
};

let currentTemplateLiteralIndex = 1;
let allTemplateLiteralTrackingValues = {};
function getCurrentTemplateLiteralTrackingValues() {
  if (!allTemplateLiteralTrackingValues[currentTemplateLiteralIndex]) {
    allTemplateLiteralTrackingValues[currentTemplateLiteralIndex] = [];
  }
  return allTemplateLiteralTrackingValues[currentTemplateLiteralIndex];
}
function resetCurrentTemplateLiteralTrackingValues() {
  allTemplateLiteralTrackingValues[currentTemplateLiteralIndex] = [];
}
global[FunctionNames.saveTemplateLiteralExpressionTrackingValue] = function(
  expressionValue
) {
  getCurrentTemplateLiteralTrackingValues().push({
    trackingValue: lastOpTrackingResultWithoutResetting,
    valueLength: (expressionValue + "").length
  });
  return expressionValue;
};
global[FunctionNames.exitTemplateLiteralAndGetTrackingValues] = function() {
  const ret = getCurrentTemplateLiteralTrackingValues();
  resetCurrentTemplateLiteralTrackingValues();
  currentTemplateLiteralIndex--;
  return ret;
};
global[FunctionNames.enterTemplateLiteral] = function() {
  currentTemplateLiteralIndex++;
};

// note: would be good to make this spec complient, e.g. see how babel does it
// e.g. handle non own properties better
global[FunctionNames.provideObjectPatternTrackingValues] = function(
  obj,
  properties
) {
  properties = properties.map(arr => {
    let pathParts = arr[1].split(".");
    return {
      name: arr[0],
      nameInPath: pathParts[pathParts.length - 1],
      path: arr[1],
      isRest: !!arr[2],
      parentPath: pathParts.slice(0, -1).join(".")
    };
  });

  let propertiesByParentPath = {};
  properties.forEach(p => {
    propertiesByParentPath[p.parentPath] =
      propertiesByParentPath[p.parentPath] || [];
    propertiesByParentPath[p.parentPath].push(p);
  });

  const res = {};
  Object.keys(propertiesByParentPath).forEach(parentPath => {
    let props = propertiesByParentPath[parentPath];
    const subObj = objectPath.withInheritedProps.get(obj, parentPath);
    let rest = { ...subObj };

    let subRes = parentPath ? {} : res;

    props.forEach(prop => {
      if (prop.isRest) {
      } else {
        objectPath.set(
          subRes,
          prop.nameInPath,
          objectPath.withInheritedProps.get(obj, prop.path)
        );
        let trackingValue = ctx.getObjectPropertyTrackingValue(
          subObj,
          prop.nameInPath
        );
        // The tracking values are set directly on res
        objectPath.set(res, prop.name + "___tv", trackingValue);
        delete rest[prop.nameInPath];
      }
    });

    props.forEach(prop => {
      if (prop.isRest) {
        // !!!!! I THINK OBJECT.KEYS HERE MEAN WE MISS SOME NON OWN PROPERTIES !!!!
        Object.keys(rest).forEach(key => {
          objectPath.set(
            subRes,
            key,
            objectPath.withInheritedProps.get(
              obj,
              (parentPath ? parentPath + "." : "") + key
            )
          );
        });
      }
    });

    if (parentPath) {
      objectPath.set(res, parentPath, subRes);
    }
  });

  return res;
};

global["__fromJSMaybeMapInitialPageHTML"] = function() {
  if (!global["__fromJSInitialPageHtml"]) {
    return;
  }
  if (global["__fromJSDidMapInitialPageHTML"]) {
    return;
  }

  const initialPageHtml = global["__fromJSInitialPageHtml"];

  if (document.body) {
    // If there's not head tag these items are put in the body and would
    // otherwise affect mapping, so remove them before we do the mapping
    document
      .querySelectorAll("[data-fromjs-remove-before-initial-html-mapping]")
      .forEach(el => el.remove());

    const tvIndex = window["__fromJSInitialPageHtmlLogIndex"];

    createOperationLog(
      {
        operation: OperationTypes.initialPageHtml,
        args: {},
        runtimeArgs: {
          url: location.href
        },
        result: initialPageHtml
      },
      operations[OperationTypes.initialPageHtml],
      tvIndex
    );

    mapPageHtml(document, initialPageHtml, tvIndex, "initial page html");

    global["__fromJSDidMapInitialPageHTML"] = true;
  }
};

global["__fromJSMaybeMapInitialPageHTML"]();

global["__fromJSCallFunctionWithTrackingChainInterruption"] = function(fn) {
  const ret = global[FunctionNames.doOperation](
    "callExpression",
    [[fn, null], [this, null], []],
    {}
  );
  return ret;
};

global["__fromJSRegisterLuckyMatch"] = function(value) {
  let valueTv = global[FunctionNames.getFunctionArgTrackingInfo](0);
  luckyMatchQueue.push({
    value,
    trackingValue: valueTv
  });
};
